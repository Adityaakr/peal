import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { hashPair, merkleTree, verifyProof } from '../src/merkle.js';

const leaf = (i: number) => keccak256(toHex(i, { size: 32 }));

describe('reveal merkle tree', () => {
  it('matches the hand-built three-leaf tree the contract was first proven against', () => {
    const leaves = [leaf(0), leaf(1), leaf(2)];
    const layer1 = [hashPair(leaves[0]!, leaves[1]!), leaves[2]!];
    const root = hashPair(layer1[0]!, layer1[1]!);
    const t = merkleTree(leaves);
    expect(t.root).toBe(root);
    expect(t.proof(0)).toEqual([leaves[1], layer1[1]]);
    expect(t.proof(1)).toEqual([leaves[0], layer1[1]]);
    expect(t.proof(2)).toEqual([layer1[0]]);
  });

  it('every proof verifies with the sorted-pair walk, for every size up to 70', () => {
    for (let n = 1; n <= 70; n += 1) {
      const leaves = Array.from({ length: n }, (_, i) => leaf(i));
      const t = merkleTree(leaves);
      for (let i = 0; i < n; i += 1) {
        expect(verifyProof(leaves[i]!, t.proof(i), t.root), `n=${n} i=${i}`).toBe(true);
      }
      // A proof for one leaf must not verify another.
      if (n > 1) expect(verifyProof(leaves[0]!, t.proof(1), t.root)).toBe(false);
    }
  });

  it('a single leaf is its own root', () => {
    const t = merkleTree([leaf(7)]);
    expect(t.root).toBe(leaf(7));
    expect(t.proof(0)).toEqual([]);
  });

  it('sorts pairs so order does not matter', () => {
    expect(hashPair(leaf(1), leaf(2))).toBe(hashPair(leaf(2), leaf(1)));
  });

  it('refuses an empty tree', () => {
    expect(() => merkleTree([])).toThrow(RangeError);
  });
});
