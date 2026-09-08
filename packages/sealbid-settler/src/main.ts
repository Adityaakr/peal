// The SealBid settler: the committee's on-chain arm for auctions.
//
// It watches every auction the factory has created. When bidding has ended it
// closes the commit phase; when the coordinator reports the auction's condition
// has opened, it joins the opened slots to the committed bids by ciphertext
// hash, builds the reveal tree, collects the committee's signatures over the
// root, and drives registerRevealRoot -> processReveals -> finalize. If the
// reveal deadline passes first, it triggers the permissionless failure so
// escrow is refundable.
//
// What it cannot do is the point. Bids are sealed with batched threshold
// encryption (BTE), and the plaintexts come from the committee's threshold
// decryption, not from this process; it sees nothing before the cue. Each
// revealed bid is checked by the contract against the commitment its bidder
// posted before the close, so
// the settler cannot alter a bid; the tree must cover exactly the committed
// count, so it cannot omit one; and the root must carry a threshold of
// committee signatures, so it cannot invent one. It holds a gas key and, on
// the demo deployment, the derivable committee keys. Both are stated limits.
//
// Modelled on packages/mempool-agents/src/settler.ts, which does the same job
// for the encrypted mempool.
import {
  ACTIVE,
  activeChain,
  AuctionState,
  CommitteeRegistryAbi,
  SealedBidAuctionAbi,
  conditionIdFromEpoch,
  fundGas,
  orderSignatures,
  planReveal,
  readAuction,
  readBids,
  readListings,
  type AuctionSnapshot,
  type OpenedSlot,
  type RevealPlan,
} from 'peal-auctionkit';
import { createPublicClient, createWalletClient, encodePacked, http, keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

// Strip trailing slashes so "https://host/" does not become "https://host//v0".
const COORD = (process.env.COORDINATOR_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const POLL_MS = Number(process.env.POLL_MS ?? 5000);
const LISTINGS_MS = Number(process.env.LISTINGS_MS ?? 60_000);
/** processReveals entries per transaction. Each entry is a merkle proof plus
 * a storage write, so this is bounded by gas, not by taste. */
const CHUNK = Number(process.env.REVEAL_CHUNK ?? 40);
/** After a failed write, leave that auction alone for this long. */
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 60_000);

/** Tempo's eth_estimateGas under-provisions writes (see mempool-agents/config.ts).
 * TX_GAS pins a generous limit; unused gas is not charged. */
const rawTxGas = process.env.TX_GAS?.replace(/[^0-9]/g, '');
const writeGas: { gas?: bigint } = rawTxGas ? { gas: BigInt(rawTxGas) } : {};

function requireKey(name: string): Hex {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return (v.startsWith('0x') ? v : `0x${v}`) as Hex;
}

/** The keys that sign the reveal root.
 *
 * COMMITTEE_KEYS is the real thing: one key per operator, comma separated, and
 * on a real deployment each operator holds its own and this process holds none.
 * DEMO_COMMITTEE=1 derives the five published testnet keys from
 * DeploySealBidStack.s.sol, so the demo stack settles with no secret at all.
 * That is a prop, and the pages say so. */
function committeeAccounts(): PrivateKeyAccount[] {
  const env = process.env.COMMITTEE_KEYS;
  if (env) {
    return env
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
      .map((k) => privateKeyToAccount((k.startsWith('0x') ? k : `0x${k}`) as Hex));
  }
  if (process.env.DEMO_COMMITTEE === '1') {
    return Array.from({ length: 5 }, (_, i) =>
      privateKeyToAccount(keccak256(encodePacked(['string', 'uint256'], ['peal-demo-committee-', BigInt(i)]))),
    );
  }
  throw new Error('set COMMITTEE_KEYS (comma-separated operator keys) or DEMO_COMMITTEE=1');
}

const settler = privateKeyToAccount(requireKey('SETTLER_PRIVATE_KEY'));
const committee = committeeAccounts();

const pub = createPublicClient({
  chain: activeChain,
  transport: http(undefined, { timeout: 20_000, retryCount: 2, retryDelay: 500 }),
  batch: { multicall: { wait: 16 } },
});
const wallet = createWalletClient({ account: settler, chain: activeChain, transport: http() });

// ---------------------------------------------------------------------------
// Coordinator

interface RevealSlotWire {
  position: number;
  ct_hash: string;
  is_dummy: boolean;
  payload_b64: string;
}

/** The opened batch, or null while the condition has not revealed. */
async function fetchReveal(conditionId: string): Promise<OpenedSlot[] | null> {
  const resp = await fetch(`${COORD}/v0/reveals/${encodeURIComponent(conditionId)}`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`coordinator ${resp.status} on reveal ${conditionId}`);
  const body = (await resp.json()) as { slots?: RevealSlotWire[] };
  return (body.slots ?? []).map((s) => ({
    ctHash: s.ct_hash,
    payload: Uint8Array.from(Buffer.from(s.payload_b64, 'base64')),
    isDummy: s.is_dummy,
  }));
}

// ---------------------------------------------------------------------------
// Chain writes

type Fn = 'closeCommit' | 'registerRevealRoot' | 'processReveals' | 'finalize' | 'failOnRevealTimeout';

async function write(auction: Address, functionName: Fn, args: readonly unknown[]): Promise<Hex> {
  const hash = await wallet.writeContract({
    address: auction,
    abi: SealedBidAuctionAbi,
    functionName,
    args: args as never,
    chain: activeChain,
    ...writeGas,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (rcpt.status !== 'success') throw new Error(`${functionName} reverted in ${hash}`);
  console.log(`[settler] ${short(auction)} ${functionName} ok in ${hash} (block ${rcpt.blockNumber})`);
  return hash;
}

// ---------------------------------------------------------------------------
// Per-auction logic

const done = new Set<string>();
const cooldownUntil = new Map<string, number>();
const warned = new Set<string>();

function short(a: string): string {
  return `${a.slice(0, 8)}…${a.slice(-4)}`;
}

function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[settler] ${msg}`);
}

async function plan(snap: AuctionSnapshot, conditionId: string): Promise<RevealPlan | null> {
  const slots = await fetchReveal(conditionId);
  if (!slots) return null;
  const bids = await readBids(pub, snap.address);
  const p = planReveal({ chainId: ACTIVE.chainId, auction: snap.address, bids, slots });
  if (p.unmatched.length) {
    for (const u of p.unmatched) {
      console.warn(`[settler] ${short(snap.address)} bid #${u.bidId} will be voided: ${u.reason}`);
    }
  }
  return p;
}

async function signRoot(snap: AuctionSnapshot, p: RevealPlan): Promise<Hex[]> {
  const setId = snap.config.committeeSetId;
  const threshold = Number(
    await pub.readContract({
      address: ACTIVE.committeeRegistry,
      abi: CommitteeRegistryAbi,
      functionName: 'thresholdOf',
      args: [setId],
    }),
  );
  const memberFlags = await Promise.all(
    committee.map((a) =>
      pub.readContract({
        address: ACTIVE.committeeRegistry,
        abi: CommitteeRegistryAbi,
        functionName: 'isMember',
        args: [setId, a.address],
      }),
    ),
  );
  const members = committee.filter((_, i) => memberFlags[i]);
  if (members.length < threshold) {
    throw new Error(
      `only ${members.length} of the configured keys are members of committee set ${setId}; need ${threshold}`,
    );
  }
  const digest = (await pub.readContract({
    address: snap.address,
    abi: SealedBidAuctionAbi,
    functionName: 'revealRootDigest',
    args: [p.root, p.bidCount],
  })) as Hex;
  const sigs = await Promise.all(
    members.slice(0, threshold).map(async (a) => ({ signer: a.address, signature: await a.sign({ hash: digest }) })),
  );
  return orderSignatures(sigs);
}

/** Send every entry the chain has not seen, in bounded chunks. */
async function processPending(snap: AuctionSnapshot, p: RevealPlan): Promise<void> {
  const bids = await readBids(pub, snap.address);
  const seen = new Set(bids.filter((b) => b.revealed).map((b) => b.bidId));
  const pending = p.entries.filter((e) => !seen.has(e.bidId));
  for (let i = 0; i < pending.length; i += CHUNK) {
    const chunk = pending.slice(i, i + CHUNK);
    console.log(`[settler] ${short(snap.address)} processing ${chunk.length} reveal(s) (${i + chunk.length}/${pending.length})`);
    await write(snap.address, 'processReveals', [chunk]);
  }
}

async function finalizeIfReady(auction: Address, now: bigint): Promise<void> {
  const snap = await readAuction(pub, auction);
  if (snap.state !== AuctionState.Revealing) return;
  if (snap.processedBidCount !== snap.committedBidCount) return;
  if (snap.voidedBidCount > 0) {
    const lastVoidAt = (await pub.readContract({
      address: auction,
      abi: SealedBidAuctionAbi,
      functionName: 'lastVoidAt',
    })) as bigint;
    const openUntil = lastVoidAt + snap.config.voidDisputeWindow;
    if (now < openUntil) {
      warnOnce(`${auction}:dispute`, `${short(auction)} waits for the void dispute window (until ${openUntil})`);
      return;
    }
  }
  await write(auction, 'finalize', []);
}

async function handle(auction: Address, now: bigint): Promise<void> {
  if (done.has(auction)) return;
  const until = cooldownUntil.get(auction) ?? 0;
  if (Date.now() < until) return;

  const snap = await readAuction(pub, auction);

  switch (snap.state) {
    case AuctionState.Settled:
    case AuctionState.Failed:
    case AuctionState.Cancelled:
      done.add(auction);
      return;

    case AuctionState.CommitOpen: {
      if (now < snap.config.endTime) return;
      await write(auction, 'closeCommit', []);
      return;
    }

    case AuctionState.CommitClosed:
    case AuctionState.Revealing: {
      // The objective recovery path. Escrow is never trapped behind a reveal
      // that did not happen, whatever the reason.
      if (now >= snap.config.revealDeadline) {
        await write(auction, 'failOnRevealTimeout', []);
        return;
      }
      const conditionId = conditionIdFromEpoch(snap.config.encryptionEpoch);
      if (!conditionId) {
        warnOnce(
          `${auction}:legacy`,
          `${short(auction)} is not sealed to a coordinator condition (epoch ${snap.config.encryptionEpoch.slice(0, 12)}…); ` +
            `it will fail to refunds at its reveal deadline`,
        );
        return;
      }
      const p = await plan(snap, conditionId);
      if (!p) return; // the condition has not fired yet

      if (snap.state === AuctionState.CommitClosed) {
        console.log(
          `[settler] ${short(auction)} opened by ${conditionId}: ${p.matched.length} of ${p.bidCount} bid(s) match; registering root ${p.root.slice(0, 12)}…`,
        );
        const signatures = await signRoot(snap, p);
        await write(auction, 'registerRevealRoot', [p.root, p.bidCount, signatures]);
      } else {
        const onchain = (await pub.readContract({
          address: auction,
          abi: SealedBidAuctionAbi,
          functionName: 'revealRoot',
        })) as Hex;
        if (onchain.toLowerCase() !== p.root.toLowerCase()) {
          throw new Error(`registered root ${onchain} differs from the recomputed ${p.root}; refusing to continue`);
        }
      }
      await processPending(snap, p);
      await finalizeIfReady(auction, now);
      return;
    }

    default:
      return; // Created, Funded, RevealPending: nothing for the settler to do yet
  }
}

// ---------------------------------------------------------------------------
// Loop

let listings: Address[] = [];
let listingsAt = 0;

async function refreshListings(): Promise<void> {
  const pinned = process.env.AUCTIONS;
  if (pinned) {
    listings = pinned.split(',').map((a) => a.trim()).filter(Boolean) as Address[];
    return;
  }
  if (Date.now() - listingsAt < LISTINGS_MS) return;
  const all = await readListings(pub, ACTIVE.factory, ACTIVE.factoryBlock);
  listings = all.map((l) => l.auction);
  listingsAt = Date.now();
}

let busy = false;
async function poll(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await refreshListings();
    const now = (await pub.getBlock()).timestamp;
    for (const auction of listings) {
      try {
        await handle(auction, now);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[settler] ${short(auction)}: ${msg.split('\n')[0]}`);
        cooldownUntil.set(auction, Date.now() + COOLDOWN_MS);
      }
    }
  } catch (e) {
    console.error('[settler] poll error:', e instanceof Error ? e.message : e);
  } finally {
    busy = false;
  }
}

async function main(): Promise<void> {
  console.log(
    `[settler] ${settler.address} on ${ACTIVE.name} (${ACTIVE.chainId}); coordinator ${COORD}; ` +
      `factory ${ACTIVE.factory}; ${committee.length} committee key(s)`,
  );
  // Tempo charges gas in a stablecoin a fresh key can claim from the chain
  // itself, so the settler tops itself up rather than needing a funding step.
  try {
    const funded = await fundGas(pub, ACTIVE, settler.address);
    if (funded) console.log('[settler] claimed gas from the chain faucet');
  } catch (e) {
    console.warn('[settler] gas faucet:', e instanceof Error ? e.message : e);
  }
  await poll();
  setInterval(() => void poll(), POLL_MS);
}

void main();
