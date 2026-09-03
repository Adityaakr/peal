// The batch tree, in JavaScript, for driving the program from a test.
//
// This is a third implementation of a scheme that already exists twice in this
// repo, which is normally a smell. It earns its place by being the client side:
// the program verifies proofs, so something has to build them, and building
// them with the program's own Rust would let one bug cancel another out.
//
// It matches crates/bte-coordinator/src/merkle.rs:
//   leaf   = sha256(position_le_u32 || payload)
//   parent = sha256(left || right)   (an odd node is promoted unchanged)
//   empty  = sha256("")
import { createHash } from 'node:crypto';

export const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

export function u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

export const leaf = (position, payload) => sha256(concat(u32le(position), payload));

/** Every level of the tree, leaves first, root last. */
function levels(leaves) {
  const out = [leaves];
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha256(concat(level[i], level[i + 1])) : level[i]);
    }
    out.push(next);
    level = next;
  }
  return out;
}

export const root = (leaves) => (leaves.length === 0 ? sha256(new Uint8Array(0)) : levels(leaves).at(-1)[0]);

/** The sibling path for `index`, bottom up. Promoted levels contribute nothing. */
export function proof(leaves, index) {
  const ls = levels(leaves);
  const out = [];
  let idx = index;
  for (let d = 0; d < ls.length - 1; d++) {
    const level = ls[d];
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (sibling < level.length) out.push(level[sibling]);
    idx = Math.floor(idx / 2);
  }
  return out;
}
