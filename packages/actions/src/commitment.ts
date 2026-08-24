/** The ordering commitment: the thing that makes "the executor could not have
 * front-run you" checkable rather than promised.
 *
 * Peal already produces a merkle root at reveal time, over (position, payload).
 * That root is necessary but it is not sufficient for this product, because it
 * only exists AFTER the payloads are readable. By then an executor that wanted
 * to reorder has already had its chance.
 *
 * So there are two roots, at two times, and they answer two different questions:
 *
 *   orderingRoot  committed BEFORE any share is released.
 *                 Leaves are sha256(intentId || ciphertextHash) — no plaintext
 *                 exists yet, and none is needed. Answers: "was my intent in
 *                 this batch, at this position, before anyone could read it?"
 *
 *   revealRoot    produced at reveal, by the coordinator (see SDK anchor.ts).
 *                 Leaves are sha256(position || payload). Answers: "is the
 *                 payload that executed the one that was in that slot?"
 *
 * Together they close the loop: position fixed while blind, payload bound to
 * position once open. Either one alone leaves a gap an executor could work in.
 *
 * The tree construction deliberately mirrors the coordinator's merkle.rs —
 * sha256 leaves, parent = sha256(left || right), odd node promoted — so both
 * roots are the same shape and one reviewer can check one construction.
 */

import { sha256, toHex, fromHex, digestsEqual } from './hash.js';

/** One entry in a committed batch, in its committed position. */
export interface CommittedSlot {
  position: number;
  intentId: string;
  ciphertextHash: string;
  /** Padding. Peal pads batches to B with coordinator-sealed dummies, and the
   * root covers them too, so a proof against the root is a proof about the
   * whole batch rather than only its real slots. */
  isDummy: boolean;
}

/** What the executor signs, and what it can never take back. */
export interface BatchCommitment {
  batchId: string;
  conditionId: string;
  orderingRoot: string;
  batchSize: number;
  /** Committee params digest the batch was sealed under. */
  encryptionKeyId: string;
  /** Who is bound by this. An address, verified against configured executors. */
  committer: string;
  committedAt: number;
  signature?: string;
}

/** leaf = sha256(utf8(intentId) || 0x00 || ciphertextHashBytes)
 *
 * The 0x00 separator is not decoration. Without it, concatenating a variable
 * length id directly onto a fixed hash lets two different (id, hash) pairs
 * produce identical bytes, and two intents would share a leaf. */
export async function orderingLeaf(intentId: string, ciphertextHash: string): Promise<Uint8Array> {
  const id = new TextEncoder().encode(intentId);
  const ct = fromHex(ciphertextHash);
  const buf = new Uint8Array(id.length + 1 + ct.length);
  buf.set(id, 0);
  buf[id.length] = 0x00;
  buf.set(ct, id.length + 1);
  return sha256(buf);
}

async function parent(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  const buf = new Uint8Array(left.length + right.length);
  buf.set(left, 0);
  buf.set(right, left.length);
  return sha256(buf);
}

async function leaves(slots: readonly CommittedSlot[]): Promise<Uint8Array[]> {
  const ordered = [...slots].sort((a, b) => a.position - b.position);
  // Positions must be exactly 0..n-1. A gap or a duplicate would still produce
  // a root, and that root would be meaningless.
  ordered.forEach((s, i) => {
    if (s.position !== i) throw new Error(`batch positions must be dense from 0; got ${s.position} at index ${i}`);
  });
  return Promise.all(ordered.map((s) => orderingLeaf(s.intentId, s.ciphertextHash)));
}

/** The root an executor commits to before a single decryption share exists. */
export async function computeOrderingRoot(slots: readonly CommittedSlot[]): Promise<string> {
  let level = await leaves(slots);
  if (level.length === 0) throw new Error('cannot commit to an empty batch');
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i]!;
      const r = level[i + 1];
      next.push(r === undefined ? l : await parent(l, r));
    }
    level = next;
  }
  return toHex(level[0]!);
}

/** A sibling path. `right` says which side the sibling sits on, which is what
 * makes the proof position-binding: swap the flags and you get a different
 * root, so a proof cannot be reused at another index. */
export interface InclusionProof {
  position: number;
  batchSize: number;
  siblings: Array<{ hash: string; right: boolean }>;
}

export async function buildInclusionProof(
  slots: readonly CommittedSlot[],
  position: number,
): Promise<InclusionProof> {
  let level = await leaves(slots);
  if (position < 0 || position >= level.length) throw new Error(`position ${position} is outside the batch`);
  const batchSize = level.length;
  const siblings: Array<{ hash: string; right: boolean }> = [];
  let idx = position;

  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i]!;
      const r = level[i + 1];
      if (r === undefined) {
        // Promoted odd node: it moves up untouched, so there is no sibling to
        // record. Recording one here would make the proof unverifiable.
        next.push(l);
      } else {
        if (i === idx) siblings.push({ hash: toHex(r), right: true });
        else if (i + 1 === idx) siblings.push({ hash: toHex(l), right: false });
        next.push(await parent(l, r));
      }
    }
    idx = Math.floor(idx / 2);
    level = next;
  }

  return { position, batchSize, siblings };
}

/**
 * Recompute the root from a leaf and its path.
 *
 * Note what this proves and what it does not: it proves the (intentId,
 * ciphertextHash) pair sat at `position` in a batch whose root is `root`. It
 * says nothing about whether that root was ever committed to, or by whom —
 * that is the executor signature's job, checked separately in receipt.ts.
 */
export async function verifyInclusion(
  intentId: string,
  ciphertextHash: string,
  proof: InclusionProof,
  root: string,
): Promise<boolean> {
  try {
    let node = await orderingLeaf(intentId, ciphertextHash);
    for (const sib of proof.siblings) {
      const s = fromHex(sib.hash);
      node = sib.right ? await parent(node, s) : await parent(s, node);
    }
    return digestsEqual(toHex(node), root);
  } catch {
    return false;
  }
}

/** Canonical bytes an executor signs to commit to a batch. Covers the root, the
 * size, and the key id: a signature over the root alone would let an executor
 * re-present the same root as a different-sized batch. */
export function commitmentPreimage(c: BatchCommitment): string {
  return [
    'peal.batch-commitment.v1',
    c.batchId,
    c.conditionId,
    c.orderingRoot,
    String(c.batchSize),
    c.encryptionKeyId,
    c.committer.toLowerCase(),
    String(c.committedAt),
  ].join('\n');
}
