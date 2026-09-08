/** The reveal tree, built the way `SealedBidAuction.processReveals` verifies it.
 *
 * The contract checks each entry with OpenZeppelin's `MerkleProof.verifyCalldata`,
 * which walks the proof hashing each pair in sorted order:
 *
 *     parent = keccak256(min(a, b) || max(a, b))
 *
 * Sorted pairs mean a proof carries no left/right flags, so any tree whose
 * parents are built that way verifies. This one pairs leaves in order and
 * promotes an odd node unchanged, which matches the hand-built tree in
 * `test/e2e.test.ts` that the contract was first proven against.
 *
 * Leaves are `revealLeaf(...)`, already double-hashed by the caller, so a leaf
 * cannot be mistaken for an internal node.
 */
import { concat, keccak256, type Hex } from 'viem';

export function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export interface MerkleTree {
  root: Hex;
  leaves: Hex[];
  /** Sibling hashes from the leaf up, in the order the contract consumes them. */
  proof(index: number): Hex[];
}

export function merkleTree(leaves: Hex[]): MerkleTree {
  if (leaves.length === 0) throw new RangeError('a reveal tree needs at least one leaf');

  const layers: Hex[][] = [leaves.slice()];
  while (layers[layers.length - 1]!.length > 1) {
    const below = layers[layers.length - 1]!;
    const above: Hex[] = [];
    for (let i = 0; i < below.length; i += 2) {
      above.push(i + 1 < below.length ? hashPair(below[i]!, below[i + 1]!) : below[i]!);
    }
    layers.push(above);
  }

  return {
    root: layers[layers.length - 1]![0]!,
    leaves: layers[0]!,
    proof(index: number): Hex[] {
      if (index < 0 || index >= leaves.length) throw new RangeError(`no leaf at ${index}`);
      const out: Hex[] = [];
      let i = index;
      for (let depth = 0; depth < layers.length - 1; depth += 1) {
        const layer = layers[depth]!;
        const sibling = i ^ 1;
        if (sibling < layer.length) out.push(layer[sibling]!);
        i >>= 1;
      }
      return out;
    },
  };
}

/** What the contract computes. Here so a test can prove `merkleTree` against
 * the same walk rather than against itself. */
export function verifyProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return h === root;
}
