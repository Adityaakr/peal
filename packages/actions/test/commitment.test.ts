import { describe, expect, it } from 'vitest';
import {
  buildInclusionProof,
  commitmentPreimage,
  computeOrderingRoot,
  orderingLeaf,
  verifyInclusion,
  type CommittedSlot,
} from '../src/commitment.js';
import { toHex } from '../src/hash.js';

function ct(n: number): string {
  return n.toString(16).padStart(2, '0').repeat(32);
}

function batch(size: number): CommittedSlot[] {
  return Array.from({ length: size }, (_, i) => ({
    position: i,
    intentId: `intent_${i}`,
    ciphertextHash: ct(i + 1),
    isDummy: false,
  }));
}

describe('ordering root', () => {
  it('is deterministic', async () => {
    const b = batch(8);
    expect(await computeOrderingRoot(b)).toBe(await computeOrderingRoot(b));
  });

  it('does not depend on the order the slots are handed in', async () => {
    // Positions are authoritative, not array order — the coordinator may return
    // rows in any order and the root must not move.
    const b = batch(8);
    const shuffled = [b[3]!, b[0]!, b[7]!, b[1]!, b[6]!, b[2]!, b[5]!, b[4]!];
    expect(await computeOrderingRoot(shuffled)).toBe(await computeOrderingRoot(b));
  });

  it('changes when any slot is reordered', async () => {
    // This is the property the whole commitment exists for: an executor cannot
    // swap two positions after committing and still present the same root.
    const b = batch(8);
    const before = await computeOrderingRoot(b);
    const swapped = b.map((s) => ({ ...s }));
    swapped[2]!.position = 5;
    swapped[5]!.position = 2;
    expect(await computeOrderingRoot(swapped)).not.toBe(before);
  });

  it('changes when a slot is inserted, deleted, or replaced', async () => {
    const b = batch(8);
    const before = await computeOrderingRoot(b);

    const inserted = [...b.map((s) => ({ ...s }))];
    inserted.forEach((s, i) => { if (i >= 4) s.position = i + 1; });
    inserted.splice(4, 0, { position: 4, intentId: 'sneaky', ciphertextHash: ct(99), isDummy: false });
    expect(await computeOrderingRoot(inserted)).not.toBe(before);

    const deleted = b.slice(0, 7).map((s) => ({ ...s }));
    expect(await computeOrderingRoot(deleted)).not.toBe(before);

    const replaced = b.map((s) => ({ ...s }));
    replaced[3]!.ciphertextHash = ct(200);
    expect(await computeOrderingRoot(replaced)).not.toBe(before);
  });

  it('refuses a batch with gaps or duplicate positions', async () => {
    const gap = batch(4);
    gap[2]!.position = 9;
    await expect(computeOrderingRoot(gap)).rejects.toThrow(/dense/);

    const dup = batch(4);
    dup[2]!.position = 1;
    await expect(computeOrderingRoot(dup)).rejects.toThrow(/dense/);
  });

  it('refuses an empty batch', async () => {
    await expect(computeOrderingRoot([])).rejects.toThrow(/empty/);
  });

  it('separates the id from the hash so two pairs cannot collide', async () => {
    // Without a separator, ("a", "bb...") and ("ab", "b...") could concatenate
    // to identical bytes. They must not share a leaf.
    const a = await orderingLeaf('ab', ct(1));
    const b = await orderingLeaf('a', ct(1));
    expect(toHex(a)).not.toBe(toHex(b));
  });
});

describe('inclusion proofs', () => {
  for (const size of [1, 2, 3, 5, 8, 9, 64]) {
    it(`verify at every position in a batch of ${size}`, async () => {
      const b = batch(size);
      const root = await computeOrderingRoot(b);
      for (let i = 0; i < size; i++) {
        const proof = await buildInclusionProof(b, i);
        expect(await verifyInclusion(b[i]!.intentId, b[i]!.ciphertextHash, proof, root)).toBe(true);
      }
    });
  }

  it('fails when the claimed position is wrong', async () => {
    // Position binding: slot 2's proof must not verify slot 5's membership.
    const b = batch(8);
    const root = await computeOrderingRoot(b);
    const proof = await buildInclusionProof(b, 2);
    expect(await verifyInclusion(b[5]!.intentId, b[5]!.ciphertextHash, proof, root)).toBe(false);
  });

  it('fails when a sibling side is flipped', async () => {
    const b = batch(8);
    const root = await computeOrderingRoot(b);
    const proof = await buildInclusionProof(b, 3);
    const tampered = { ...proof, siblings: proof.siblings.map((s) => ({ ...s, right: !s.right })) };
    expect(await verifyInclusion(b[3]!.intentId, b[3]!.ciphertextHash, tampered, root)).toBe(false);
  });

  it('fails when a sibling hash is tampered with', async () => {
    const b = batch(8);
    const root = await computeOrderingRoot(b);
    const proof = await buildInclusionProof(b, 3);
    const tampered = { ...proof, siblings: [{ ...proof.siblings[0]!, hash: ct(0xee) }, ...proof.siblings.slice(1)] };
    expect(await verifyInclusion(b[3]!.intentId, b[3]!.ciphertextHash, tampered, root)).toBe(false);
  });

  it('fails for an intent that was never in the batch', async () => {
    const b = batch(8);
    const root = await computeOrderingRoot(b);
    const proof = await buildInclusionProof(b, 3);
    expect(await verifyInclusion('never_submitted', ct(0xab), proof, root)).toBe(false);
  });

  it('fails against a different batch root', async () => {
    const b = batch(8);
    const proof = await buildInclusionProof(b, 3);
    const otherRoot = await computeOrderingRoot(batch(8).map((s) => ({ ...s, intentId: `x_${s.position}` })));
    expect(await verifyInclusion(b[3]!.intentId, b[3]!.ciphertextHash, proof, otherRoot)).toBe(false);
  });

  it('returns false rather than throwing on a malformed proof', async () => {
    const b = batch(4);
    const root = await computeOrderingRoot(b);
    const bad = { position: 0, batchSize: 4, siblings: [{ hash: 'not-hex', right: true }] };
    expect(await verifyInclusion(b[0]!.intentId, b[0]!.ciphertextHash, bad, root)).toBe(false);
  });

  it('refuses to build a proof outside the batch', async () => {
    await expect(buildInclusionProof(batch(4), 4)).rejects.toThrow(/outside/);
    await expect(buildInclusionProof(batch(4), -1)).rejects.toThrow(/outside/);
  });

  it('covers dummy padding slots too', async () => {
    // Peal pads to B with coordinator dummies. The root spans them, so a proof
    // is about the whole batch and a dummy cannot be swapped for a real slot.
    const b = batch(6);
    b[4]!.isDummy = true;
    b[5]!.isDummy = true;
    const root = await computeOrderingRoot(b);
    const proof = await buildInclusionProof(b, 4);
    expect(await verifyInclusion(b[4]!.intentId, b[4]!.ciphertextHash, proof, root)).toBe(true);
  });
});

describe('commitment preimage', () => {
  const base = {
    batchId: 'batch_1',
    conditionId: 'cond_1',
    orderingRoot: ct(7),
    batchSize: 64,
    encryptionKeyId: ct(3),
    committer: '0xAbC0000000000000000000000000000000000001',
    committedAt: 1_700_000_000,
  };

  it('is stable and case-insensitive on the committer address', async () => {
    expect(commitmentPreimage(base)).toBe(
      commitmentPreimage({ ...base, committer: base.committer.toLowerCase() }),
    );
  });

  it('changes when the batch size changes', () => {
    // A signature over the root alone would let the same root be re-presented
    // as a differently sized batch.
    expect(commitmentPreimage({ ...base, batchSize: 63 })).not.toBe(commitmentPreimage(base));
  });

  it('changes when any bound field changes', () => {
    const p = commitmentPreimage(base);
    expect(commitmentPreimage({ ...base, orderingRoot: ct(8) })).not.toBe(p);
    expect(commitmentPreimage({ ...base, encryptionKeyId: ct(4) })).not.toBe(p);
    expect(commitmentPreimage({ ...base, committedAt: base.committedAt + 1 })).not.toBe(p);
    expect(commitmentPreimage({ ...base, conditionId: 'cond_2' })).not.toBe(p);
  });
});
