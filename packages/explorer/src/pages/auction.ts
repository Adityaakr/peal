// AuctionKit: the /auction section — a live sealed-bid auction on Ethereum Hoodi.
//
// This page places a real bid on a real chain. Everything it shows is read from
// the auction contract; nothing is mocked, and there is no simulated mode to
// fall back to when a call fails, because a page that pretends a transaction
// worked is worse than one that says it could not reach the chain.
//
// What is honestly private here, and what is not:
//
//   - HIDDEN until the auction closes: the split between quantity and price.
//     The chain sees one commitment hash and nothing about what is inside it.
//   - VISIBLE immediately: the escrow. It is an ERC-20 transfer of
//     quantity x maxPrice, so anyone watching sees that product. They cannot
//     separate the factors, but a distinctive amount is a fingerprint.
//
// The page says so, in those words. Claiming bid-size privacy would need
// shielded funding, which is not implemented.
import {
  HOODI,
  HOODI_DEMO,
  STATE_LABELS,
  allocationFor,
  demandFromBids,
  findClearingTick,
  prepareBid,
  priceAt,
  priceLadder,
  readAuction,
  readBids,
  submitBid,
  DemoTokenAbi,
  DemoFaucetAbi,
  SealedBidAuctionAbi,
  hoodiChain,
  type AuctionSnapshot,
  type CommittedBid,
  type PreparedBid,
} from 'peal-auctionkit';
import {
  animateLadder,
  animateWall,
  attachTilt,
  bidWallHtml,
  ladderHtml,
  type LadderRow,
  type WallBid,
} from '../auction-visuals';
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  keccak256,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { recoverSeededBid } from '../demo-bids';
import { esc, truncMiddle } from '../util';

type Cleanup = () => void;

const RPC = 'https://rpc.hoodi.ethpandaops.io';
// From the package, so the multicall3 address travels with it. A bare chain
// literal silently disables viem's batching: 60 reads measured 3008ms without
// the declaration and 727ms with it.
const CHAIN = hoodiChain;

// A public RPC will occasionally be slow or refuse. Bound the wait and retry
// rather than letting a single hung request hold the page in "loading".
// `batch` collapses the per-bid reads into one JSON-RPC call where the chain
// has multicall3, which is most of what this page does per refresh.
const pub = createPublicClient({
  chain: CHAIN,
  transport: http(RPC, { timeout: 12_000, retryCount: 2, retryDelay: 400 }),
  batch: { multicall: { wait: 16 } },
});

/** viem errors carry the whole request body, which is unreadable in a banner.
 * Keep the one line that tells a person what to do. */
function briefly(e: unknown): string {
  const err = e as { shortMessage?: string; details?: string; message?: string };
  const m = err?.shortMessage ?? err?.details ?? err?.message ?? String(e);
  const firstLine = m.split('\n')[0]!.trim();
  return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
}

/** Bids live in localStorage because the salt exists nowhere else.
 *
 * Losing it means the bid can never be revealed: the commitment cannot be
 * reproduced, the reveal is voided, and the bidder gets a refund and no
 * allocation. That is the single most important thing this page persists, so
 * it is also offered as a downloadable file. */
const STORE_KEY = 'peal.auctionkit.bids.v1';

interface SavedBid {
  chainId: number;
  auction: Address;
  bidder: Address;
  /** Unknown until the commit lands, because the contract assigns it. `null`
   * means the transaction is still in flight or was never confirmed. */
  bidId: number | null;
  quantity: string;
  maxPriceTick: number;
  salt: Hex;
  bidVersion: number;
  /** The stable key. Unlike `bidId` this is known before the transaction is
   * sent, which is what lets the salt be persisted first. */
  commitment: Hex;
  escrow: string;
  txHash: Hex | null;
  at: number;
}

function loadBids(): SavedBid[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as SavedBid[]) : [];
  } catch {
    return [];
  }
}

function writeBids(all: SavedBid[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    /* private browsing, quota. The page still works and the download is the
       durable copy, but the salt is now only in memory. */
  }
}

/** Persist a bid BEFORE its transaction is sent.
 *
 * This ordering is the whole point. The salt is generated locally and exists
 * nowhere else: not on the chain, not at the coordinator, not with the
 * committee. If it is written only after the receipt, then closing the tab
 * while the transaction is in flight leaves escrow locked against a bid that
 * can never be revealed. The bidder would be refunded and get no allocation,
 * with nothing anywhere to reconstruct what they meant to bid.
 *
 * Keyed by commitment rather than bidId, because bidId does not exist yet. */
function saveBid(b: SavedBid): void {
  writeBids([...loadBids().filter((x) => x.commitment !== b.commitment), b]);
}

/** Fill in what only the chain could tell us, once it has. */
function completeBid(commitment: Hex, bidId: number, txHash: Hex): void {
  writeBids(loadBids().map((b) => (b.commitment === commitment ? { ...b, bidId, txHash } : b)));
}

function ethereum(): { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } | null {
  const w = window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } };
  return w.ethereum ?? null;
}

function fmt(v: bigint, decimals: number, places = 4): string {
  const s = formatUnits(v, decimals);
  const [i, f = ''] = s.split('.');
  return f ? `${i}.${f.slice(0, places).replace(/0+$/, '') || '0'}` : i!;
}

/** "in 4m", or a clock time once it is far enough out to be worth one. */
function fmtWhen(atSec: bigint): string {
  const delta = Number(atSec) - Math.floor(Date.now() / 1000);
  if (delta <= 0) return 'now';
  if (delta < 90) return `in ${delta}s`;
  if (delta < 3600) return `in ${Math.ceil(delta / 60)}m`;
  return `at ${new Date(Number(atSec) * 1000).toLocaleTimeString()}`;
}

function countdown(toSec: bigint, nowSec: bigint): string {
  let d = Number(toSec - nowSec);
  if (d <= 0) return 'closed';
  const h = Math.floor(d / 3600);
  d -= h * 3600;
  const m = Math.floor(d / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${d - m * 60}s`;
}

/** Which auction this page is showing.
 *
 * Was hardcoded to the demo, which meant there was exactly one auction and no
 * way to share another. Now every read takes the address, and the token symbols
 * are read from the chain rather than assumed, because a stranger's auction
 * will not be selling PEALD for DUSD. */
export interface AuctionTarget {
  auction: Address;
  quoteToken: Address;
  saleToken: Address;
  saleSymbol: string;
  quoteSymbol: string;
  /** Only the demo tokens have a faucet. A real auction's quote token has no
   * reason to mint on request, so the panel is hidden rather than offered and
   * then failing. */
  faucet?: Address;
}

export const DEMO_TARGET: AuctionTarget = {
  auction: HOODI_DEMO.auction,
  quoteToken: HOODI_DEMO.quoteToken,
  saleToken: HOODI_DEMO.saleToken,
  saleSymbol: HOODI_DEMO.saleSymbol,
  quoteSymbol: HOODI_DEMO.quoteSymbol,
  faucet: HOODI_DEMO.faucet,
};

export function renderAuction(root: HTMLElement, target: AuctionTarget = DEMO_TARGET): Cleanup {
  let stopped = false;
  let account: Address | null = null;
  let snap: AuctionSnapshot | null = null;
  let quoteBalance = 0n;
  let bids: CommittedBid[] = [];
  let faucetMax = 0n;
  let faucetAvailableAt = 0n;
  let faucetBusy = false;
  let detachTilt: (() => void) | null = null;
  let status = '';
  let statusKind: 'info' | 'error' | 'ok' = 'info';
  let busy = false;

  root.innerHTML = `<section class="ak"><h1>Sealed-bid auction</h1><p class="ak-sub">Loading from ${esc(HOODI.name)}…</p></section>`;

  /** Each read is independent on purpose.
   *
   * These used to share one try block, so a slow bid fetch also discarded the
   * auction state and the balance, and the page fell back to its "cannot reach
   * the chain" state while the chain was perfectly reachable. Now a partial
   * failure keeps whatever did load, and only the missing part is reported. */
  async function refresh(): Promise<void> {
    const failures: string[] = [];

    try {
      snap = await readAuction(pub, target.auction);
    } catch (e) {
      failures.push(`auction state (${briefly(e)})`);
    }

    // Sealed bids are still public *objects*: the commitment, the escrow and
    // the bidder are onchain. Showing them is what makes the guarantee legible.
    // You can see a bid exists and see that its contents are not there.
    try {
      bids = await readBids(pub, target.auction);
    } catch (e) {
      failures.push(`bids (${briefly(e)})`);
    }

    if (account) {
      try {
        quoteBalance = (await pub.readContract({
          address: target.quoteToken,
          abi: DemoTokenAbi,
          functionName: 'balanceOf',
          args: [account],
        })) as bigint;
      } catch (e) {
        failures.push(`balance (${briefly(e)})`);
      }

      // Ask the faucet what it would actually give this address, rather than
      // assuming the cap. It answers 0 while cooling down and reports its own
      // remaining balance when that is the smaller number, so the button can
      // say why instead of letting someone send a reverting transaction.
      //
      // Only the demo tokens have a faucet. A real issuer's payment token has
      // no reason to mint on request, so there is nothing to ask.
      const faucetAddr = target.faucet;
      if (faucetAddr) try {
        const [amount, availableAt] = (await pub.readContract({
          address: faucetAddr,
          abi: DemoFaucetAbi,
          functionName: 'claimableBy',
          args: [account],
        })) as [bigint, bigint];
        faucetMax = amount;
        faucetAvailableAt = availableAt;
      } catch (e) {
        failures.push(`faucet (${briefly(e)})`);
      }
    }

    // Never overwrite a message the user is acting on, such as a wallet error
    // or a bid confirmation, with a transient network note.
    if (statusKind !== 'error' || status.startsWith('Could not load')) {
      if (failures.length) {
        status = `Could not load ${failures.join(', ')}. Retrying.`;
        statusKind = 'error';
      } else if (status.startsWith('Could not load')) {
        status = '';
      }
    }
    if (!stopped) draw();
  }

  async function connect(): Promise<void> {
    const eth = ethereum();
    if (!eth) {
      status = 'No injected wallet found. Install MetaMask or another EIP-1193 wallet.';
      statusKind = 'error';
      draw();
      return;
    }
    try {
      const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as Address[];
      account = accounts[0] ?? null;

      // Switch, or add the chain if the wallet has never seen Hoodi.
      const hexChain = `0x${HOODI.chainId.toString(16)}`;
      try {
        await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChain }] });
      } catch {
        await eth.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: hexChain,
            chainName: HOODI.name,
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [RPC],
            blockExplorerUrls: [HOODI.explorer],
          }],
        });
      }
      status = '';
      await refresh();
    } catch (e) {
      status = briefly(e);
      statusKind = 'error';
      draw();
    }
  }

  async function placeBid(quantityStr: string, tick: number): Promise<void> {
    if (!snap || !account || busy) return;
    const eth = ethereum();
    if (!eth) return;
    busy = true;
    status = 'Preparing bid locally…';
    statusKind = 'info';
    draw();

    try {
      const quantity = parseUnits(quantityStr, snap.config.saleDecimals);
      const bid: PreparedBid = prepareBid({
        cfg: snap.config,
        chainId: HOODI.chainId,
        auction: target.auction,
        bidder: account,
        quantity,
        maxPriceTick: tick,
      });

      if (bid.escrow > quoteBalance) {
        throw new Error(
          `Escrow needs ${fmt(bid.escrow, snap.config.quoteDecimals)} ${target.quoteSymbol}, ` +
            `you hold ${fmt(quoteBalance, snap.config.quoteDecimals)}.`,
        );
      }

      const wallet = createWalletClient({ account, chain: CHAIN, transport: custom(eth) });
      status = 'Approve the escrow, then confirm the bid…';
      draw();

      // Written before the transaction exists. See saveBid.
      saveBid({
        chainId: HOODI.chainId,
        auction: target.auction,
        bidder: account,
        bidId: null,
        quantity: quantity.toString(),
        maxPriceTick: tick,
        salt: bid.salt,
        bidVersion: bid.bidVersion,
        commitment: bid.commitment,
        escrow: bid.escrow.toString(),
        txHash: null,
        at: Math.floor(Date.now() / 1000),
      });

      const res = await submitBid({
        publicClient: pub,
        walletClient: wallet,
        account,
        auction: target.auction,
        quoteToken: target.quoteToken,
        bid,
        // Stands in for the Peal ciphertext hash until sealing is wired in.
        // Registered onchain so ciphertext loss stays provable and attributable.
        ciphertextHash: keccak256(stringToHex(`${account}:${bid.salt}`)),
      });

      completeBid(bid.commitment, res.bidId, res.commitTx);

      status = `Bid #${res.bidId} committed. Save your salt. Without it the bid cannot be revealed.`;
      statusKind = 'ok';
    } catch (e) {
      status = briefly(e);
      statusKind = 'error';
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function claimFaucet(amountStr: string): Promise<void> {
    if (!account || faucetBusy || !snap || !target.faucet) return;
    const eth = ethereum();
    if (!eth) return;

    let amount: bigint;
    try {
      amount = parseUnits(amountStr.trim() || '0', snap.config.quoteDecimals);
    } catch {
      status = 'Enter an amount, for example 500000.';
      statusKind = 'error';
      draw();
      return;
    }

    // Checked here so a hopeless request never costs gas. The contract enforces
    // the same bounds; this only saves the user a failed transaction.
    if (amount <= 0n) {
      status = 'Enter an amount greater than zero.';
      statusKind = 'error';
      draw();
      return;
    }
    if (faucetMax === 0n) {
      const wait = faucetAvailableAt > 0n ? ` Try again ${fmtWhen(faucetAvailableAt)}.` : '';
      status = `The faucet has nothing for this address right now.${wait}`;
      statusKind = 'error';
      draw();
      return;
    }
    if (amount > faucetMax) {
      status = `The faucet will give at most ${fmt(faucetMax, snap.config.quoteDecimals, 0)} ${target.quoteSymbol} per claim.`;
      statusKind = 'error';
      draw();
      return;
    }

    faucetBusy = true;
    status = 'Confirm the claim in your wallet.';
    statusKind = 'info';
    draw();

    try {
      const wallet = createWalletClient({ account, chain: CHAIN, transport: custom(eth) });
      const hash = await wallet.writeContract({
        chain: CHAIN,
        account,
        address: target.faucet,
        abi: DemoFaucetAbi,
        functionName: 'claim',
        args: [amount],
      });
      await pub.waitForTransactionReceipt({ hash });
      status = `Received ${fmt(amount, snap.config.quoteDecimals, 0)} ${target.quoteSymbol}.`;
      statusKind = 'ok';
    } catch (e) {
      status = briefly(e);
      statusKind = 'error';
    } finally {
      faucetBusy = false;
      await refresh();
    }
  }

  function downloadBids(): void {
    const blob = new Blob([JSON.stringify(loadBids(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'peal-auction-bids.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function draw(): void {
    if (!snap) {
      root.innerHTML = `<section class="ak"><div class="ak-hero"><h1>Sealed-bid auction</h1>
        <p class="ak-status ak-error">${esc(status || 'Reading the chain…')}</p></div></section>`;
      return;
    }
    const c = snap.config;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const ladder = priceLadder(c);
    const saved = loadBids().filter(
      (b) => b.auction.toLowerCase() === target.auction.toLowerCase(),
    );
    const mineIds = new Set(
      saved.filter((b) => !account || b.bidder.toLowerCase() === account.toLowerCase()).map((b) => b.bidId),
    );

    // Demand is only computable once every bid is revealed or voided. Before
    // that `demandFromBids` returns null and the ladder renders as sealed —
    // never as zeros, which a reader could mistake for "nobody bid".
    const demand = demandFromBids(bids, c.numTicks);
    const clearing = demand ? findClearingTick(demand, c.totalSupply) : null;

    const wallBids: WallBid[] = bids.map((b) => {
      const sealed = !b.revealed && !b.voided;
      // Only claims a bid is readable when the published parameters actually
      // reproduce its onchain commitment. Never true for a real user's bid.
      const recovered = sealed
        ? recoverSeededBid({
            chainId: HOODI.chainId,
            auction: target.auction,
            bidder: b.bidder,
            commitment: b.commitment,
          })
        : null;
      const qty = b.revealed ? b.quantity : recovered?.quantity;
      const tick = b.revealed ? b.tick : recovered?.tick;
      return {
        bidId: b.bidId,
        bidder: b.bidder,
        commitment: b.commitment,
        escrow: fmt(b.escrow, c.quoteDecimals, 2),
        sealed,
        voided: b.voided,
        recovered: recovered !== null,
        isMine: mineIds.has(b.bidId) || (!!account && b.bidder.toLowerCase() === account.toLowerCase()),
        quantity: qty !== undefined ? fmt(qty, c.saleDecimals, 2) : undefined,
        price: tick !== undefined ? fmt(priceAt(c.reservePrice, c.tickSize, tick), c.quoteDecimals) : undefined,
        allocation:
          clearing && b.revealed && !b.voided
            ? fmt(allocationFor(clearing, b.quantity, b.tick), c.saleDecimals, 2)
            : undefined,
      };
    });

    const rows: LadderRow[] | null =
      demand && clearing
        ? ladder.map((l) => ({
            tick: l.tick,
            price: fmt(l.price, c.quoteDecimals),
            demand: Number(formatUnits(demand[l.tick] ?? 0n, c.saleDecimals)),
            isClearing: clearing.cleared && clearing.clearingTick === l.tick,
          }))
        : null;

    const trulySealed = wallBids.filter((b) => b.sealed && !b.recovered).length;
    const recoverable = wallBids.filter((b) => b.sealed && b.recovered).length;
    const totalEscrow = bids.reduce((s2, b) => s2 + b.escrow, 0n);

    root.innerHTML = `
<section class="ak">
  <div class="ak-hero">
    <div class="ak-hero-copy">
      <div class="ak-eyebrow">
        <span class="ak-live-dot"></span> Live on ${esc(HOODI.name)}, a testnet
      </div>
      <h1>Bids stay sealed<br/>until the auction closes.</h1>
      <p class="ak-lede">
        Every bid below is real and onchain right now. You can see that each one <em>exists</em>,
        and that the seller cannot read what is inside it, and neither can another bidder.
        At close they are revealed together and settle at one uniform price.
      </p>
      <div class="ak-hero-meta">
        <a href="${HOODI.explorer}/address/${target.auction}" target="_blank" rel="noopener">
          <code>${esc(truncMiddle(target.auction, 8, 6))}</code></a>
        <span class="ak-state ak-state-${snap.state}">${esc(STATE_LABELS[snap.state] ?? String(snap.state))}</span>
      </div>
    </div>
    <div class="ak-hero-vis" id="ak-hero-vis">
      <div class="ak-vault-3d">
        <div class="ak-vault-face ak-vf-front">
          <div class="ak-vault-lock"></div>
          <div class="ak-vault-count">${bids.length}</div>
          <div class="ak-vault-label">${bids.length === 1 ? 'sealed bid' : 'sealed bids'}</div>
        </div>
        <div class="ak-vault-face ak-vf-back"></div>
        <div class="ak-vault-face ak-vf-left"></div>
        <div class="ak-vault-face ak-vf-right"></div>
        <div class="ak-vault-face ak-vf-top"></div>
        <div class="ak-vault-face ak-vf-bottom"></div>
      </div>
      <div class="ak-vault-glow"></div>
    </div>
  </div>

  <div class="ak-grid">
    <div class="ak-card"><span>For sale</span><strong>${fmt(c.totalSupply, c.saleDecimals, 0)}</strong><em>${esc(target.saleSymbol)}</em></div>
    <div class="ak-card"><span>Reserve price</span><strong>${fmt(c.reservePrice, c.quoteDecimals)}</strong><em>${esc(target.quoteSymbol)}</em></div>
    <div class="ak-card"><span>Bids sealed</span><strong>${trulySealed}</strong><em>of ${bids.length}${recoverable ? `, ${recoverable} salt published` : ''}</em></div>
    <div class="ak-card"><span>Escrow locked</span><strong>${fmt(totalEscrow, c.quoteDecimals, 0)}</strong><em>${esc(target.quoteSymbol)}</em></div>
    <div class="ak-card ak-card-time"><span>${snap.biddingOpen ? 'Closes in' : 'Bidding'}</span><strong>${esc(countdown(c.endTime, now))}</strong><em>${snap.biddingOpen ? '' : 'ended'}</em></div>
  </div>

  ${status ? `<p class="ak-status ak-${statusKind}">${esc(status)}</p>` : ''}

  <div class="ak-cols">
    <div class="ak-col-main">
      <h2 class="ak-h2">The wall <span class="ak-h2-note">every bid, live from chain</span></h2>
      <div id="ak-wall-scene" class="ak-scene">${bidWallHtml(wallBids, target.quoteSymbol, target.saleSymbol)}</div>

      <h2 class="ak-h2">Demand ladder <span class="ak-h2-note">${rows ? 'revealed' : 'sealed'}</span></h2>
      <div id="ak-ladder-scene">${ladderHtml(rows, ladder.map((l) => ({ tick: l.tick, price: fmt(l.price, c.quoteDecimals) })))}</div>
      ${clearing?.cleared
        ? `<p class="ak-clearing">Cleared at <strong>${fmt(priceAt(c.reservePrice, c.tickSize, clearing.clearingTick), c.quoteDecimals)} ${esc(target.quoteSymbol)}</strong>
             · ${fmt(clearing.supplySold, c.saleDecimals, 0)} ${esc(target.saleSymbol)} sold.
             Everyone who won pays this price, not their own maximum.</p>`
        : ''}
    </div>

    <aside class="ak-col-side">
      <div class="ak-panel">
        <h3>Place a sealed bid</h3>
        ${account
          ? `<div class="ak-acct"><span class="ak-live-dot"></span><code>${esc(truncMiddle(account, 6, 4))}</code>
               <b>${fmt(quoteBalance, c.quoteDecimals, 2)} ${esc(target.quoteSymbol)}</b></div>`
          : `<button class="ak-btn ak-primary ak-wide" id="ak-connect">Connect wallet</button>`}

        ${account && snap.biddingOpen ? `
        <form class="ak-form" id="ak-form">
          <label>Quantity <span>${esc(target.saleSymbol)}</span>
            <input id="ak-qty" type="text" inputmode="decimal" value="100" autocomplete="off" />
          </label>
          <label>Maximum price you will pay
            <select id="ak-tick">
              ${ladder.map((l) => `<option value="${l.tick}"${l.tick === 5 ? ' selected' : ''}>${fmt(l.price, c.quoteDecimals)} ${esc(target.quoteSymbol)}</option>`).join('')}
            </select>
          </label>
          <div class="ak-escrow-box" id="ak-escrow"></div>
          <button class="ak-btn ak-primary ak-wide" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Working…' : 'Seal and commit'}</button>
          <p class="ak-hint">You pay the <em>clearing</em> price, never your own maximum.</p>
        </form>` : ''}
        ${account && !snap.biddingOpen ? `<p class="ak-hint">Bidding is closed for this auction.</p>` : ''}
      </div>

      ${account && target.faucet ? `
      <div class="ak-panel">
        <h3>Test tokens <span class="ak-h2-note">free, no value</span></h3>
        <p class="ak-hint">Escrow is paid in ${esc(target.quoteSymbol)}. Claim as much as you need.</p>
        <form class="ak-form ak-faucet" id="ak-faucet-form">
          <label>Amount <span>${esc(target.quoteSymbol)}</span>
            <input id="ak-faucet-amt" type="text" inputmode="decimal" value="500000" autocomplete="off" />
          </label>
          <button class="ak-btn ak-wide" type="submit" ${faucetBusy || faucetMax === 0n ? 'disabled' : ''}>
            ${faucetBusy ? 'Claiming…' : faucetMax === 0n
              ? (faucetAvailableAt > 0n ? `Available again ${esc(fmtWhen(faucetAvailableAt))}` : 'Faucet empty')
              : 'Claim from faucet'}
          </button>
        </form>
        <p class="ak-hint">Up to ${fmt(faucetMax > 0n ? faucetMax : 0n, c.quoteDecimals, 0)} per claim, then a short cooldown.
          <a href="${HOODI.explorer}/address/${target.faucet}" target="_blank" rel="noopener">Faucet contract</a></p>
      </div>` : ''}

      <div class="ak-panel ak-panel-warn">
        <h3>What is hidden, and what is not</h3>
        <ul class="ak-facts">
          <li><b>Hidden</b> until close: your quantity and your price. The chain holds one hash.</li>
          <li><b>Public</b> immediately: your escrow, a token transfer of quantity times max price.
            The split is not published, but prices are a ladder of at most 256 ticks, so anyone
            who tries can usually narrow it to a few candidates.</li>
        </ul>
        <p>This is not bid-size privacy, and AuctionKit does not claim it is. That would need shielded funding.</p>
      </div>

      ${saved.length ? `
      <div class="ak-panel">
        <h3>Your bids <span class="ak-h2-note">this browser</span></h3>
        <p class="ak-hint">The <strong>salt</strong> exists nowhere else. Lose it and your bid cannot be revealed, so you get a refund instead of an allocation. Saved before the transaction is sent, so closing this tab mid-commit cannot strand a bid.</p>
        <table class="ak-table">
          <thead><tr><th>#</th><th>Qty</th><th>Max</th><th>Tx</th></tr></thead>
          <tbody>${saved.map((b) => `<tr${b.bidId === null ? ' class="ak-row-pending"' : ''}>
            <td>${b.bidId === null ? '&middot;' : b.bidId}</td>
            <td>${fmt(BigInt(b.quantity), c.saleDecimals, 2)}</td>
            <td>${fmt(priceAt(c.reservePrice, c.tickSize, b.maxPriceTick), c.quoteDecimals)}</td>
            <td>${b.txHash
              ? `<a href="${HOODI.explorer}/tx/${b.txHash}" target="_blank" rel="noopener">${esc(truncMiddle(b.txHash, 5, 4))}</a>`
              : '<span class="ak-pending">not confirmed</span>'}</td>
          </tr>`).join('')}</tbody>
        </table>
        <button class="ak-btn ak-wide" id="ak-download">Download bids + salts</button>
      </div>` : ''}
    </aside>
  </div>

  <p class="ak-foot">
    Testnet demo on ${esc(HOODI.name)}. The reveal committee's signing keys are
    <strong>publicly derivable</strong> (see <code>DeployDemoAuction.s.sol</code>), so it is a prop, not custody.
    Implementation <code>${esc(truncMiddle(HOODI.auctionImplementation, 8, 6))}</code>.
  </p>
</section>`;

    detachTilt?.();
    const heroVis = root.querySelector<HTMLElement>('#ak-hero-vis');
    const wallScene = root.querySelector<HTMLElement>('#ak-wall-scene');
    const ladderScene = root.querySelector<HTMLElement>('#ak-ladder-scene');
    if (wallScene) {
      const d1 = attachTilt(wallScene);
      const d2 = heroVis ? attachTilt(heroVis) : () => {};
      detachTilt = () => { d1(); d2(); };
      animateWall(wallScene);
    }
    if (ladderScene) animateLadder(ladderScene);

    root.querySelector('#ak-connect')?.addEventListener('click', () => void connect());
    root.querySelector('#ak-download')?.addEventListener('click', downloadBids);
    root.querySelector('#ak-faucet-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const el = root.querySelector<HTMLInputElement>('#ak-faucet-amt');
      if (el) void claimFaucet(el.value);
    });

    const qty = root.querySelector<HTMLInputElement>('#ak-qty');
    const tickSel = root.querySelector<HTMLSelectElement>('#ak-tick');
    const escrowEl = root.querySelector<HTMLElement>('#ak-escrow');

    const updateEscrow = (): void => {
      if (!qty || !tickSel || !escrowEl || !snap || !account) return;
      try {
        const q = parseUnits(qty.value || '0', snap.config.saleDecimals);
        const bid = prepareBid({
          cfg: snap.config, chainId: HOODI.chainId, auction: target.auction,
          bidder: account, quantity: q, maxPriceTick: Number(tickSel.value),
        });
        const short = bid.escrow > quoteBalance;
        escrowEl.innerHTML =
          `<span>Escrow</span><b>${fmt(bid.escrow, snap.config.quoteDecimals, 2)} ${esc(target.quoteSymbol)}</b>` +
          (short ? `<em class="ak-error">more than you hold</em>` : `<em>locked until settlement</em>`);
        escrowEl.className = short ? 'ak-escrow-box ak-escrow-short' : 'ak-escrow-box';
      } catch (e) {
        escrowEl.innerHTML = `<span>Escrow</span><em class="ak-error">${esc(briefly(e))}</em>`;
        escrowEl.className = 'ak-escrow-box ak-escrow-short';
      }
    };
    qty?.addEventListener('input', updateEscrow);
    tickSel?.addEventListener('change', updateEscrow);
    updateEscrow();

    root.querySelector('#ak-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (qty && tickSel) void placeBid(qty.value, Number(tickSel.value));
    });
  }

  void refresh();
  const timer = window.setInterval(() => void refresh(), 15_000);

  return () => {
    stopped = true;
    detachTilt?.();
    window.clearInterval(timer);
  };
}

/** Render any auction by address, for the shareable `#/a/0x…` link.
 *
 * Token symbols are read from the chain rather than assumed: a stranger's
 * auction is not selling PEALD for DUSD, and showing the demo's symbols beside
 * someone else's tokens would misstate what a bidder is paying with.
 *
 * The faucet is only offered when the payment token is the demo one. A real
 * issuer's token has no reason to mint on request, so the panel is hidden
 * rather than shown and then failing.
 */
export function renderAuctionAt(root: HTMLElement, auction: Address): Cleanup {
  let inner: Cleanup | null = null;
  let cancelled = false;

  root.innerHTML = `<section class="ak"><div class="ak-hero"><h1>Sealed-bid auction</h1>
    <p class="ak-sub">Reading ${esc(truncMiddle(auction, 8, 6))} from ${esc(HOODI.name)}.</p></div></section>`;

  void (async () => {
    try {
      const cfg = (await pub.readContract({
        address: auction, abi: SealedBidAuctionAbi, functionName: 'getConfig',
      })) as unknown as { saleToken: Address; quoteToken: Address };

      const [saleSymbol, quoteSymbol] = await Promise.all([
        pub.readContract({ address: cfg.saleToken, abi: DemoTokenAbi, functionName: 'symbol' }).catch(() => 'TOKEN'),
        pub.readContract({ address: cfg.quoteToken, abi: DemoTokenAbi, functionName: 'symbol' }).catch(() => 'TOKEN'),
      ]);

      if (cancelled) return;
      inner = renderAuction(root, {
        auction,
        saleToken: cfg.saleToken,
        quoteToken: cfg.quoteToken,
        saleSymbol: String(saleSymbol),
        quoteSymbol: String(quoteSymbol),
        faucet:
          cfg.quoteToken.toLowerCase() === HOODI_DEMO.quoteToken.toLowerCase()
            ? HOODI_DEMO.faucet
            : undefined,
      });
    } catch (e) {
      if (cancelled) return;
      root.innerHTML = `<section class="ak"><div class="ak-hero"><h1>Sealed-bid auction</h1>
        <p class="ak-status ak-error">Could not read an auction at ${esc(truncMiddle(auction, 8, 6))}. ${esc(briefly(e))}</p>
        <div class="ml-hero-ctas"><a class="ak-btn" href="#/auctions">see every auction</a></div>
      </div></section>`;
    }
  })();

  return () => {
    cancelled = true;
    inner?.();
  };
}
