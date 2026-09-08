import { describe, expect, it } from 'vitest';
import { sha256, type Address, type Hex } from 'viem';
import { bidCommitment, revealLeaf } from '../src/commitment.js';
import { verifyProof } from '../src/merkle.js';
import { encodeBidPayload, type BidPayload } from '../src/payload.js';
import { orderSignatures, planReveal, type CommittedBidRef, type OpenedSlot } from '../src/settle.js';

const CHAIN = 42431;
const AUCTION: Address = '0xCA90E426b2dF09C800CDb39b9F0BE00492E551B9';
const bidder = (i: number): Address => `0x${(i + 1).toString(16).padStart(40, '0')}` as Address;

/** A bid as the chain would hold it, plus the slot the coordinator would open. */
function make(i: number, tick: number, quantity: bigint): { bid: CommittedBidRef; slot: OpenedSlot; p: BidPayload } {
  const p: BidPayload = {
    chainId: CHAIN, auction: AUCTION, bidder: bidder(i), quantity, maxPriceTick: tick,
    salt: `0x${(i + 1).toString(16).padStart(64, '0')}` as Hex, bidVersion: 1,
  };
  const payload = encodeBidPayload(p);
  // Stands in for sha256(ciphertext); only equality between the two sides matters.
  const ctHash = sha256(payload);
  return {
    p,
    bid: { bidId: i, bidder: p.bidder, commitment: bidCommitment(p), ciphertextHash: ctHash },
    slot: { ctHash: ctHash.slice(2), payload }, // coordinator prints hex without 0x
  };
}

describe('planReveal', () => {
  it('reveals every matched bid and proves each entry against the root', () => {
    const rows = [make(0, 20, 500n), make(1, 10, 700n), make(2, 0, 1000n)];
    const plan = planReveal({ chainId: CHAIN, auction: AUCTION, bids: rows.map((r) => r.bid), slots: rows.map((r) => r.slot) });
    expect(plan.bidCount).toBe(3);
    expect(plan.matched).toEqual([0, 1, 2]);
    expect(plan.unmatched).toEqual([]);
    for (const [i, e] of plan.entries.entries()) {
      expect(e.quantity).toBe(rows[i]!.p.quantity);
      expect(e.tick).toBe(rows[i]!.p.maxPriceTick);
      expect(e.salt).toBe(rows[i]!.p.salt);
      expect(verifyProof(revealLeaf(e.bidId, e.quantity, e.tick, e.salt), e.proof, plan.root)).toBe(true);
    }
  });

  it('still covers a bid whose ciphertext never opened, as a void entry', () => {
    const rows = [make(0, 20, 500n), make(1, 10, 700n)];
    const plan = planReveal({ chainId: CHAIN, auction: AUCTION, bids: rows.map((r) => r.bid), slots: [rows[0]!.slot] });
    expect(plan.bidCount).toBe(2);
    expect(plan.matched).toEqual([0]);
    expect(plan.unmatched).toEqual([{ bidId: 1, reason: 'ciphertext not in batch' }]);
    const v = plan.entries[1]!;
    expect(v.quantity).toBe(0n);
    expect(v.tick).toBe(0);
    // The void entry is in the tree too, so the root covers committedBidCount.
    expect(verifyProof(revealLeaf(1, 0n, 0, v.salt), v.proof, plan.root)).toBe(true);
  });

  it('voids a plaintext that names another auction, bidder, or commitment', () => {
    const good = make(0, 5, 100n);
    const other = make(1, 5, 100n);
    // Slot 1 decrypts to a payload for a different auction.
    const foreign = encodeBidPayload({ ...other.p, auction: bidder(99) });
    // Slot 2 decrypts to a payload for the right auction but the wrong bidder.
    const swapped = make(2, 5, 100n);
    const swappedPayload = encodeBidPayload({ ...swapped.p, bidder: bidder(50) });
    // Slot 3 is a bid whose payload was altered after the commitment was posted.
    const altered = make(3, 5, 100n);
    const alteredPayload = encodeBidPayload({ ...altered.p, quantity: 999n });
    // Slot 4 is something else entirely sealed to the same condition.
    const junk = make(4, 5, 100n);

    const plan = planReveal({
      chainId: CHAIN, auction: AUCTION,
      bids: [good.bid, other.bid, swapped.bid, altered.bid, junk.bid],
      slots: [
        good.slot,
        { ctHash: other.bid.ciphertextHash, payload: foreign },
        { ctHash: swapped.bid.ciphertextHash, payload: swappedPayload },
        { ctHash: altered.bid.ciphertextHash, payload: alteredPayload },
        { ctHash: junk.bid.ciphertextHash, payload: new TextEncoder().encode('sealed bid: 42') },
        { ctHash: 'deadbeef', payload: new Uint8Array(3), isDummy: true },
      ],
    });
    expect(plan.matched).toEqual([0]);
    expect(plan.unmatched).toEqual([
      { bidId: 1, reason: 'payload names another auction' },
      { bidId: 2, reason: 'payload names another bidder' },
      { bidId: 3, reason: 'payload does not match commitment' },
      { bidId: 4, reason: 'payload is not a bid' },
    ]);
  });

  it('is deterministic, so a second run reproduces the registered root', () => {
    const rows = [make(0, 1, 1n), make(1, 2, 2n), make(2, 3, 3n), make(3, 4, 4n), make(4, 5, 5n)];
    const a = planReveal({ chainId: CHAIN, auction: AUCTION, bids: rows.map((r) => r.bid), slots: rows.map((r) => r.slot) });
    const b = planReveal({ chainId: CHAIN, auction: AUCTION, bids: [...rows].reverse().map((r) => r.bid), slots: rows.map((r) => r.slot) });
    expect(b.root).toBe(a.root);
  });

  it('refuses a gap in bid ids rather than building a root the contract would reject', () => {
    const rows = [make(0, 1, 1n), make(2, 1, 1n)];
    expect(() => planReveal({ chainId: CHAIN, auction: AUCTION, bids: rows.map((r) => r.bid), slots: [] })).toThrow(RangeError);
  });
});

describe('orderSignatures', () => {
  it('sorts by signer address ascending, as the contract requires', () => {
    const out = orderSignatures([
      { signer: bidder(2), signature: '0x03' },
      { signer: bidder(0), signature: '0x01' },
      { signer: bidder(1), signature: '0x02' },
    ]);
    expect(out).toEqual(['0x01', '0x02', '0x03']);
  });
});
