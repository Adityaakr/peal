/** From a batch opened by batched threshold encryption (BTE) to the exact
 * calldata the contract will accept.
 *
 * Pure: it takes what the chain says was committed and what the coordinator
 * says was revealed, and returns the reveal entries, the root and the proofs.
 * No network, so it can be tested with fixtures and rerun by anyone who wants
 * to check a settlement.
 *
 * The rule that shapes everything here: `registerRevealRoot` requires the root
 * to cover exactly `committedBidCount` bids, and `finalize` requires every one
 * of them to be processed. So the tree has one leaf per committed bid, always.
 * A bid whose ciphertext never opened, or opened to something that does not
 * match its commitment, still gets a leaf: a placeholder entry the contract
 * will void, refunding the bidder's escrow and letting everyone else settle.
 * That is the failure the contract was designed to absorb (decisions/0004),
 * and it is strictly better than the alternative, where one broken bid holds
 * every other bidder's escrow until the reveal deadline.
 */
import { type Address, type Hex } from 'viem';
import { bidCommitment, revealLeaf } from './commitment.js';
import { merkleTree } from './merkle.js';
import { decodeBidPayload } from './payload.js';

/** One entry of `SealedBidAuction.processReveals`. */
export interface RevealEntry {
  bidId: number;
  quantity: bigint;
  tick: number;
  salt: Hex;
  bidVersion: number;
  proof: Hex[];
}

/** What `readBids` returns, reduced to the fields a reveal needs. */
export interface CommittedBidRef {
  bidId: number;
  bidder: Address;
  commitment: Hex;
  ciphertextHash: Hex;
}

/** One opened slot of the batch. `ctHash` as the coordinator prints it (hex,
 * with or without 0x); `payload` the decrypted bytes. Dummies carry no payload
 * worth reading and may be omitted or passed with `isDummy`. */
export interface OpenedSlot {
  ctHash: string;
  payload: Uint8Array;
  isDummy?: boolean;
}

export type UnmatchedReason =
  | 'ciphertext not in batch'
  | 'payload is not a bid'
  | 'payload names another auction'
  | 'payload names another bidder'
  | 'payload does not match commitment';

export interface RevealPlan {
  entries: RevealEntry[];
  root: Hex;
  bidCount: number;
  /** Bids whose plaintext matched their commitment and will reveal. */
  matched: number[];
  /** Bids that will be voided, and why. Their escrow stays refundable. */
  unmatched: { bidId: number; reason: UnmatchedReason }[];
}

/** The entry the contract voids. Tick 0 is always below `numTicks`, so it
 * never trips `BadTick`; the zero commitment it recomputes never matches a
 * real one, so the bid is voided rather than revealed. */
const VOID = { quantity: 0n, tick: 0, salt: `0x${'0'.repeat(64)}` as Hex, bidVersion: 0 };

function normHash(h: string): string {
  return h.trim().toLowerCase().replace(/^0x/, '');
}

export function planReveal(args: {
  chainId: number;
  auction: Address;
  bids: CommittedBidRef[];
  slots: OpenedSlot[];
}): RevealPlan {
  const bids = [...args.bids].sort((a, b) => a.bidId - b.bidId);
  for (let i = 0; i < bids.length; i += 1) {
    if (bids[i]!.bidId !== i) {
      throw new RangeError(`bid ids must be contiguous from 0; saw ${bids[i]!.bidId} at ${i}`);
    }
  }
  if (bids.length === 0) throw new RangeError('nothing was committed, so there is nothing to reveal');

  const byHash = new Map<string, Uint8Array>();
  for (const s of args.slots) {
    if (s.isDummy) continue;
    byHash.set(normHash(s.ctHash), s.payload);
  }

  const matched: number[] = [];
  const unmatched: RevealPlan['unmatched'] = [];
  const bare = bids.map((b) => {
    const decide = (): { ok: true; entry: Omit<RevealEntry, 'proof'> } | { ok: false; reason: UnmatchedReason } => {
      const payload = byHash.get(normHash(b.ciphertextHash));
      if (!payload) return { ok: false, reason: 'ciphertext not in batch' };
      const p = decodeBidPayload(payload);
      if (!p) return { ok: false, reason: 'payload is not a bid' };
      if (p.chainId !== args.chainId || p.auction.toLowerCase() !== args.auction.toLowerCase()) {
        return { ok: false, reason: 'payload names another auction' };
      }
      if (p.bidder.toLowerCase() !== b.bidder.toLowerCase()) {
        return { ok: false, reason: 'payload names another bidder' };
      }
      if (bidCommitment(p).toLowerCase() !== b.commitment.toLowerCase()) {
        return { ok: false, reason: 'payload does not match commitment' };
      }
      return {
        ok: true,
        entry: { bidId: b.bidId, quantity: p.quantity, tick: p.maxPriceTick, salt: p.salt, bidVersion: p.bidVersion },
      };
    };
    const d = decide();
    if (d.ok) {
      matched.push(b.bidId);
      return d.entry;
    }
    unmatched.push({ bidId: b.bidId, reason: d.reason });
    return { bidId: b.bidId, ...VOID };
  });

  const tree = merkleTree(bare.map((e) => revealLeaf(e.bidId, e.quantity, e.tick, e.salt)));
  return {
    entries: bare.map((e, i) => ({ ...e, proof: tree.proof(i) })),
    root: tree.root,
    bidCount: bids.length,
    matched,
    unmatched,
  };
}

/** `registerRevealRoot` requires signatures in ascending signer order; that is
 * how it rejects a duplicate signer without a nested loop. */
export function orderSignatures(sigs: { signer: Address; signature: Hex }[]): Hex[] {
  return [...sigs]
    .sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : BigInt(a.signer) > BigInt(b.signer) ? 1 : 0))
    .map((s) => s.signature);
}
