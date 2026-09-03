// Independent verification of a revealed batch.
//
// The rule this file exists to enforce: a check that reads its expected value
// from the coordinator proves nothing. Recomputing the merkle root from the
// coordinator's plaintexts and comparing it to the coordinator's own published
// root only shows that one JSON blob is internally consistent. A coordinator
// that wanted to lie would publish tampered plaintexts and the matching root,
// and that check would go green.
//
// So every claim below is anchored to something the coordinator cannot retract:
// the chain (read straight from the public RPC, not through our relayer), the
// ciphertext bytes themselves, or a pairing equation. Where a claim CANNOT be
// anchored, we say so instead of quietly passing.
import type { CommitteeDetail, Reveal, RevealSlot } from './api';
import type { MempoolConfig } from './mempool/chain';
import { recomputeMerkleRoot, normalizeHex } from './merkle';
import { payloadBytes } from './util';

/** The protocol's padding marker: bte-crypto prefixes every padding payload with
 * these bytes. Never printed in the UI, where it reads like placeholder data
 * rather than the wire constant it is. */
const PADDING_MARKER = 'BTE_DUMMY_V0:';

// cast sig "settledRoot(bytes32)"
const SEL_SETTLED_ROOT = '0x08afcebd';
// cast keccak "Sealed(bytes32,bytes32,address)"
const TOPIC_SEALED = '0x86be95f3b52fdb930db9e9d10e27c3524cc831a4d3b377693e6b0ebc8c1b4d23';
// cast keccak "BatchExecuted(bytes32,bytes32,uint256)"
const TOPIC_BATCH_EXECUTED = '0xe24d0a2c61ac81c2a105d160b44f0d4854b5e899809bed5d307285d03a2dfeec';

/** The RPC rejects eth_getLogs spans over 100k blocks. Every condition the demo
 * settles is minutes old, so a trailing window is plenty. */
const LOG_WINDOW = 90_000n;

const ZERO32 = `0x${'0'.repeat(64)}`;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

export type CheckStatus = 'pass' | 'fail' | 'skip';

/** Where a check's expected value comes from. 'chain' is the only source the
 * coordinator cannot forge after the fact; the UI grades them differently. */
export type Anchor = 'chain' | 'crypto' | 'local' | 'none';

export interface Check {
  id: string;
  /** What this proves, in the user's words. */
  label: string;
  status: CheckStatus;
  anchor: Anchor;
  detail: string;
}

export interface SealedCommit {
  txHash: string;
  blockNumber: number;
  /** Who emitted it. `Sealed` indexes all three arguments, and this one decides
   * whether a commitment is evidence or noise: `commitSealed` is permissionless
   * and writes no storage, so anyone can emit a log under any condition id. */
  from: string;
}

export interface VerifyReport {
  checks: Check[];
  /** ct hash -> the on-chain commit that carried it, for per-slot links. */
  sealedCommits: Map<string, SealedCommit>;
  /** The executeBatch tx that settled this condition, if any. */
  settleTx: string | null;
  onchainRoot: string | null;
  recomputedRoot: string;
  /** Did this condition ever go on-chain? False for a capsule or a round, which
   * never commit or settle, and whose reveal is therefore checked only against
   * the ciphertexts and the operators' shares. */
  anchored: boolean;
}

// ---- raw JSON-RPC (no chain library, no relayer) -------------------------

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Condition ids are strings offchain, sha256(utf8(id)) onchain. */
async function conditionIdToBytes32(id: string): Promise<string> {
  return `0x${await sha256Hex(new TextEncoder().encode(id))}`;
}

// ---- the checks ----------------------------------------------------------

/** Each slot's ct hash, recomputed from the sealed bytes the coordinator served.
 * sha256 over the BTE_WIRE_V0 blob is exactly how the coordinator derives it, so
 * a mismatch means the bytes and the hash do not belong together. */
async function checkCtHashes(slots: RevealSlot[]): Promise<Check> {
  const withBytes = slots.filter((s) => s.sealed_b64);
  if (withBytes.length === 0) {
    return {
      id: 'ct-hash',
      label: 'every ct hash is derived from its ciphertext',
      status: 'skip',
      anchor: 'none',
      detail:
        'this coordinator did not serve the sealed ciphertexts, so the ct hashes cannot be re-derived here. they remain its unverified claim.',
    };
  }
  const bad: number[] = [];
  for (const s of withBytes) {
    const got = await sha256Hex(payloadBytes(s.sealed_b64!));
    if (normalizeHex(got) !== normalizeHex(s.ct_hash)) bad.push(s.position);
  }
  return {
    id: 'ct-hash',
    label: 'each ciphertext hash matches its ciphertext',
    status: bad.length === 0 ? 'pass' : 'fail',
    anchor: 'crypto',
    detail:
      bad.length === 0
        ? `re-hashed all ${withBytes.length} sealed ciphertexts in this browser. every sha256 equals the hash shown in the sealed column below, so that column is derived from the ciphertext bytes rather than taken on the coordinator's word.`
        : `slot ${bad.join(', ')} carries a hash that is not the sha256 of the ciphertext served for it.`,
  };
}

/** The ct hashes that were committed on-chain BEFORE the reveal, read from the
 * Sealed logs. This is the one check that catches censorship: a real order whose
 * hash is on-chain but which the reveal dropped or relabelled as padding. */
function checkSealedOnChain(
  slots: RevealSlot[],
  cfg: MempoolConfig,
  commits: Map<string, SealedCommit>,
): Check {
  const revealed = new Set(slots.map((s) => normalizeHex(s.ct_hash)));
  const link = `${cfg.explorerBase.replace(/\/$/, '')}/address/${cfg.pealMempool}`;

  // A commitment is evidence about THIS reveal only if its hash is one of the
  // ciphertexts that opened. `commitSealed` is permissionless and writes no
  // storage, so anyone can emit a Sealed log under any condition id, and Peal
  // Live emits one itself to record an auction's terms. Counting every log as a
  // ciphertext that should have appeared made both of those look like
  // censorship: a stranger with free gas could turn this panel red, and our own
  // terms record did.
  const matched = [...commits.keys()].filter((h) => revealed.has(h));
  const unattributed = commits.size - matched.length;

  // The exception, and the reason this check still means something: a hash the
  // trusted committer put on chain that is now marked padding. Nobody else can
  // produce that, because it takes a real ciphertext of this batch AND the
  // coordinator relabelling it.
  const trusted = normalizeHex(cfg.relayer ?? '');
  const authoritative =
    trusted && trusted !== ZERO_ADDRESS
      ? [...commits.entries()].filter(([, c]) => normalizeHex(c.from) === trusted).map(([h]) => h)
      : [];
  const dropped = authoritative.filter((h) => !revealed.has(h));
  const reclassified = matched.filter(
    (h) => slots.find((s) => normalizeHex(s.ct_hash) === h)?.is_dummy === true,
  );

  const bad = dropped.length + reclassified.length;
  const noise = unattributed
    ? ` ${unattributed} other commitment${unattributed === 1 ? '' : 's'} under this condition did not open here; anyone can emit one, so ${unattributed === 1 ? 'it is' : 'they are'} not counted either way.`
    : '';

  return {
    id: 'sealed-onchain',
    label: 'nothing committed on-chain was dropped or relabelled as padding',
    status: bad === 0 ? 'pass' : 'fail',
    anchor: 'chain',
    detail:
      bad === 0
        ? `${matched.length} of the ${revealed.size} ciphertexts below ${matched.length === 1 ? 'was' : 'were'} committed to <a class="link" href="${link}" target="_blank" rel="noopener">PealMempool</a> on chain ${cfg.chainId} before the cue, each timestamped by its block, and every one of them opened here as a real seal rather than as padding.${noise}`
        : `${dropped.length} commitment(s) from the committing account are absent from this reveal, and ${reclassified.length} opened as padding. something that was sealed was then not opened.`,
  };
}

/** The merkle root the CHAIN settled, vs the root we recompute from the
 * plaintexts. The contract recomputes the tree itself in executeBatch and
 * reverts on mismatch, so a root in settledRoot is one the chain already
 * checked against the calldata it executed. */
function checkOnchainRoot(
  recomputed: string,
  onchainRoot: string | null,
  cfg: MempoolConfig,
): Check {
  // Only reachable when the orders were committed on-chain but the settlement
  // transaction has not landed yet, so this is a pending state, not an absence.
  if (!onchainRoot || onchainRoot === ZERO32) {
    return {
      id: 'onchain-root',
      label: 'the chain settled these exact plaintexts',
      status: 'skip',
      anchor: 'none',
      detail:
        'the orders were committed on-chain, but settlement has not landed yet, so there is no settled root to hold this reveal against. it appears here once the batch is executed.',
    };
  }
  const ok = normalizeHex(onchainRoot) === normalizeHex(recomputed);
  const link = `${cfg.explorerBase.replace(/\/$/, '')}/address/${cfg.pealMempool}`;
  return {
    id: 'onchain-root',
    label: 'the chain settled these exact plaintexts',
    status: ok ? 'pass' : 'fail',
    anchor: 'chain',
    detail: ok
      ? `the merkle root rebuilt in this browser from the plaintexts below equals <a class="link" href="${link}" target="_blank" rel="noopener">settledRoot</a> read from the contract. the contract recomputes that tree itself at settlement and rejects a mismatch, so these are the plaintexts the chain executed, and no later edit can change them.`
      : `the root rebuilt from these plaintexts does not equal the one the chain settled. what is shown here is not what was executed.`,
  };
}

/** Padding must actually be padding. The merkle leaf covers only (position,
 * payload), NOT the is_dummy flag, so the root alone cannot stop the coordinator
 * from classifying an order as padding. The padding marker in the payload can. */
function checkPadding(slots: RevealSlot[], noun: string): Check {
  const mislabelled = slots.filter((s) => {
    if (!s.valid) return false;
    const text = new TextDecoder().decode(
      payloadBytes(s.payload_b64).slice(0, PADDING_MARKER.length),
    );
    return s.is_dummy !== (text === PADDING_MARKER);
  });
  const pad = slots.filter((s) => s.is_dummy).length;
  return {
    id: 'padding',
    label: `no ${noun} is concealed among the padding slots`,
    status: mislabelled.length === 0 ? 'pass' : 'fail',
    anchor: 'local',
    detail:
      mislabelled.length === 0
        ? `every one of the ${pad} padding slots carries the protocol's padding marker, and no ${noun} slot carries it. because the plaintexts are fixed by the root above, this classification cannot be revised afterwards.`
        : `slot ${mislabelled.map((s) => s.position).join(', ')} is classified inconsistently with its payload: a ${noun} is being presented as padding.`,
  };
}

/** Positions are a pure function of the ct hash set: real ciphertexts sorted
 * ascending by hash, padding appended. Nobody gets to pick their slot, so
 * nobody gets to buy priority. */
function checkOrdering(slots: RevealSlot[], noun: string): Check {
  const ordered = [...slots].sort((a, b) => a.position - b.position);
  const real = ordered.filter((s) => !s.is_dummy);
  const contiguous = real.every((s, i) => s.position === i);
  const sorted = real.every(
    (s, i) => i === 0 || normalizeHex(real[i - 1].ct_hash) <= normalizeHex(s.ct_hash),
  );
  const ok = contiguous && sorted;
  const one = real.length === 1;
  return {
    id: 'ordering',
    label: 'slot order is determined by the ciphertext hashes',
    status: ok ? 'pass' : 'fail',
    anchor: 'local',
    detail: ok
      ? `the ${real.length} ${noun}${one ? '' : 's'} occup${one ? 'ies the leading slot' : 'y the leading slots'} in ascending hash order, with padding filling the tail. a position is a function of the ciphertext's hash, which nobody can steer without discarding the ciphertext, so no participant chooses their own slot.`
      : `the ${noun} slots are not in ascending hash order, so the ordering was chosen rather than derived.`,
  };
}

/** The only cryptographic proof that the committee actually did the work: run
 * each operator's share through the same pairing equation the coordinator ran.
 * Catches a coordinator that fabricated a reveal without a real t-of-n quorum,
 * and one that marked a bad share "verified". */
async function checkShares(r: Reveal, committee: CommitteeDetail | null): Promise<Check> {
  const headers = new Map(r.batches.map((b) => [b.batch_id, b.headers_b64]));
  const usable = r.shares.filter((s) => s.share_b64 && headers.get(s.batch_id));
  if (!committee?.params_b64 || usable.length === 0) {
    return {
      id: 'shares',
      label: 'a real quorum of operators opened this batch',
      status: 'skip',
      anchor: 'none',
      detail:
        'this coordinator did not serve the share bytes, so the pairing check cannot be rerun here. the "verified" marks below are its own claim.',
    };
  }
  const { verifyShare } = await import('bte-sdk/verify');
  let good = 0;
  const disputed: number[] = [];
  for (const s of usable) {
    let ok = false;
    try {
      ok = await verifyShare(committee.params_b64, headers.get(s.batch_id)!, s.share_b64!);
    } catch {
      ok = false;
    }
    if (ok) good++;
    if (ok !== s.verified) disputed.push(s.operator_id);
  }
  const t = committee.t;
  const enough = good >= t;
  const consistent = disputed.length === 0;
  return {
    id: 'shares',
    label: 'a threshold quorum of operators produced this decryption',
    status: enough && consistent ? 'pass' : 'fail',
    anchor: 'crypto',
    detail:
      enough && consistent
        ? `re-ran the pairing check on all ${usable.length} operator shares against the batch headers, here in the browser. ${good} are valid and ${t} are required. a share cannot be produced without the operator's key share, so the decryption came from the committee and not from the coordinator alone.`
        : !enough
          ? `only ${good} shares satisfy the pairing check, but ${t} are required. this reveal cannot have come from a threshold quorum.`
          : `operator ${disputed.join(', ')} is recorded differently by the coordinator than the pairing check finds. its record of who verified is wrong.`,
  };
}

// ---- driver --------------------------------------------------------------

/** Read the chain directly (never through the relayer) for the two facts that
 * anchor everything else: the settled root, and the pre-reveal Sealed commits. */
async function readChain(
  conditionId: string,
  cfg: MempoolConfig,
): Promise<{ onchainRoot: string | null; commits: Map<string, SealedCommit>; settleTx: string | null }> {
  const cond32 = await conditionIdToBytes32(conditionId);
  const commits = new Map<string, SealedCommit>();
  let onchainRoot: string | null = null;
  let settleTx: string | null = null;

  const latest = BigInt(await rpc<string>(cfg.rpcUrl, 'eth_blockNumber', []));
  const from = `0x${(latest > LOG_WINDOW ? latest - LOG_WINDOW : 0n).toString(16)}`;

  const [root, sealedLogs, batchLogs] = await Promise.all([
    rpc<string>(cfg.rpcUrl, 'eth_call', [
      { to: cfg.pealMempool, data: `${SEL_SETTLED_ROOT}${cond32.slice(2)}` },
      'latest',
    ]),
    rpc<{ topics: string[]; transactionHash: string; blockNumber: string }[]>(
      cfg.rpcUrl,
      'eth_getLogs',
      [{ address: cfg.pealMempool, topics: [TOPIC_SEALED, cond32], fromBlock: from }],
    ),
    rpc<{ transactionHash: string }[]>(cfg.rpcUrl, 'eth_getLogs', [
      { address: cfg.pealMempool, topics: [TOPIC_BATCH_EXECUTED, cond32], fromBlock: from },
    ]),
  ]);

  onchainRoot = root;
  for (const log of sealedLogs) {
    // Sealed(conditionId, ctHash, from): all three indexed, so ctHash is topic2
    // and the sender is topic3, left-padded to a word.
    commits.set(normalizeHex(log.topics[2]), {
      txHash: log.transactionHash,
      blockNumber: Number(BigInt(log.blockNumber)),
      from: `0x${(log.topics[3] ?? '').slice(-40).toLowerCase()}`,
    });
  }
  if (batchLogs.length > 0) settleTx = batchLogs[0].transactionHash;
  return { onchainRoot, commits, settleTx };
}

/** Run every check we can, in parallel where possible. Never throws: a chain
 * that cannot be reached downgrades the on-chain checks to 'skip' rather than
 * silently passing them. */
export async function verifyReveal(
  r: Reveal,
  cfg: MempoolConfig | null,
  committee: CommitteeDetail | null,
  /** What one sealed item is called on this lane: a swap is an "order", a time
   * capsule is a "seal". Talking about orders and priority under a capsule reads
   * as copy pasted from somewhere else. */
  noun = 'seal',
): Promise<VerifyReport> {
  const recomputedRoot = await recomputeMerkleRoot(r.slots);

  let onchainRoot: string | null = null;
  let commits = new Map<string, SealedCommit>();
  let settleTx: string | null = null;
  let chainError: string | null = null;

  if (cfg?.rpcUrl && cfg.pealMempool) {
    try {
      const read = await readChain(r.condition_id, cfg);
      onchainRoot = read.onchainRoot;
      commits = read.commits;
      settleTx = read.settleTx;
    } catch (e) {
      chainError = e instanceof Error ? e.message : String(e);
    }
  } else {
    chainError = 'no chain endpoint is configured for this explorer.';
  }

  const checks: Check[] = [];

  // Whether this condition ever went on-chain at all. Only the mempool lane
  // commits and settles; a capsule or a round never does, and for those the two
  // chain checks are not applicable rather than unsatisfied. Listing them as
  // skipped would make an ordinary condition look deficient, so they are simply
  // not offered. That is a different thing from being UNABLE to reach the chain,
  // which stays visible below: a check that should have run and did not is
  // exactly what must never be quietly dropped.
  const settled = !!onchainRoot && onchainRoot !== ZERO32;
  // "Anchored" has to mean a ciphertext FROM THIS REVEAL is on chain, not that
  // some Sealed log exists under this condition id. Those are different things,
  // because `commitSealed` is permissionless: a stranger could make any
  // condition look anchored, and Peal Live's own terms record did exactly that,
  // which is what pushed an ordinary auction into offering two chain checks it
  // was never going to satisfy.
  const revealedHashes = new Set(r.slots.map((s) => normalizeHex(s.ct_hash)));
  const ctAnchored = [...commits.keys()].some((h) => revealedHashes.has(h));
  const anchored = settled || ctAnchored;

  if (chainError) {
    const detail = `could not reach the chain (${chainError}), so the on-chain anchors could not be read. no coordinator claim is being substituted for them.`;
    checks.push(
      { id: 'onchain-root', label: 'the chain settled these exact plaintexts', status: 'skip', anchor: 'none', detail },
      { id: 'sealed-onchain', label: 'every order was committed on-chain before it was opened', status: 'skip', anchor: 'none', detail },
    );
  } else {
    // Each chain check is offered only when it is applicable. A settled root
    // exists only for a lane that calls executeBatch, and a ciphertext
    // commitment only for one that anchors its ciphertexts. Listing either as
    // skipped on a condition that was never going to have it makes an ordinary
    // auction look deficient; the code below already says that is the thing to
    // avoid, and the fix is to be honest about which are applicable rather than
    // to show them greyed out forever.
    if (settled) checks.push(checkOnchainRoot(recomputedRoot, onchainRoot, cfg!));
    if (ctAnchored) checks.push(checkSealedOnChain(r.slots, cfg!, commits));
  }

  checks.push(await checkCtHashes(r.slots));
  checks.push(await checkShares(r, committee));
  checks.push(checkPadding(r.slots, noun));
  checks.push(checkOrdering(r.slots, noun));

  return { checks, sealedCommits: commits, settleTx, onchainRoot, recomputedRoot, anchored };
}
