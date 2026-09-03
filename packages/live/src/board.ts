/** Revealed slots in, a ranked board out.
 *
 * Two things here are deliberately not taken on trust.
 *
 * Padding is identified by the literal marker the crate writes into every dummy
 * payload (crates/bte-crypto/src/lib.rs:458), not by the `is_dummy` flag the
 * coordinator serves alongside it. The flag is the coordinator's assertion; the
 * marker is in the bytes that were sealed, and it is checkable by anyone.
 *
 * The auction id is read from inside each sealed record rather than assumed
 * from which condition the slot arrived in. A ciphertext is not bound to a
 * condition (SECURITY.md:38-42), so a blob can be replayed from one auction
 * into another and will decrypt cleanly. A bid that names a different auction
 * is a replay and does not count.
 *
 * The result is a QUEUE, not a single winner. Nothing is escrowed, so the top
 * bid is a claim rather than a payment, and an auction whose answer is one name
 * has no answer at all the moment that person does not pay. Ordering everyone
 * who is eligible means a bid nobody intends to honour costs the seller the
 * time it takes to read the next line.
 */
import { decodeBid, type BidOrigin } from './record.js';
import type { Terms } from './terms.js';

/** The marker every dummy payload starts with. */
export const PADDING_MARKER = 'BTE_DUMMY_V0:';

/** One slot as `GET /v0/reveals/:id` serves it. */
export interface RevealedSlot {
  position: number;
  ct_hash: string;
  payload_b64: string;
  is_dummy?: boolean;
}

export interface BoardEntry {
  position: number;
  ctHash: string;
  name: string;
  amountMinor: number;
  /** What the bidder typed, when they typed it in another currency. Display
   * only: `amountMinor` above is what this bid is ranked on. */
  origin: BidOrigin | null;
  /** False when a reserve was set and this bid is under it. Still shown: it
   * was a real bid, it just cannot win. */
  meetsReserve: boolean;
  /** False when a maximum was set and this bid is over it. Also still shown,
   * and deliberately: a bid placed to disrupt the auction is more useful
   * visible and out of the running than quietly deleted. */
  withinCap: boolean;
}

export interface DiscardedSlot {
  position: number;
  ctHash: string;
  reason: 'unreadable' | 'other-auction';
}

export interface Board {
  /** Every valid bid for this auction, best first, whether or not it can win. */
  bids: BoardEntry[];
  /** Those inside both the reserve and the cap, in the order they should be
   * offered the item. The seller works down this list. */
  queue: BoardEntry[];
  /** First in the queue. Wins if they pay, which is all this can ever mean
   * without escrow. */
  winner: BoardEntry | null;
  /** Slots that were the coordinator's own padding. */
  padding: number;
  discarded: DiscardedSlot[];
}

function payloadBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function isPadding(bytes: Uint8Array): boolean {
  const marker = new TextEncoder().encode(PADDING_MARKER);
  if (bytes.length < marker.length) return false;
  return marker.every((b, i) => bytes[i] === b);
}

export function buildBoard(slots: readonly RevealedSlot[], terms: Terms): Board {
  const bids: BoardEntry[] = [];
  const discarded: DiscardedSlot[] = [];
  let padding = 0;

  // A ct hash is a content address, so it names one ciphertext. Two slots
  // carrying the same one is the coordinator repeating itself, and a repeated
  // bid would be a second row on the board and a second chance to win.
  const seen = new Set<string>();

  for (const slot of slots) {
    if (seen.has(slot.ct_hash)) continue;
    seen.add(slot.ct_hash);
    const bytes = payloadBytes(slot.payload_b64);
    if (!bytes) {
      discarded.push({ position: slot.position, ctHash: slot.ct_hash, reason: 'unreadable' });
      continue;
    }
    if (isPadding(bytes)) {
      padding++;
      continue;
    }
    const bid = decodeBid(bytes);
    if (!bid) {
      discarded.push({ position: slot.position, ctHash: slot.ct_hash, reason: 'unreadable' });
      continue;
    }
    if (bid.auctionId !== terms.auctionId) {
      discarded.push({ position: slot.position, ctHash: slot.ct_hash, reason: 'other-auction' });
      continue;
    }
    bids.push({
      position: slot.position,
      ctHash: slot.ct_hash,
      name: bid.name,
      amountMinor: bid.amountMinor,
      origin: bid.origin ?? null,
      meetsReserve: terms.reserveMinor === null || bid.amountMinor >= terms.reserveMinor,
      withinCap: terms.maxMinor === null || bid.amountMinor <= terms.maxMinor,
    });
  }

  // Ties break on position, which is the batch's own ordering: reals sort
  // ascending by ct_hash at freeze (crates/bte-coordinator/src/engine.rs), so
  // it is a pure function of the ciphertext set. It is not arrival order and
  // the host cannot steer it, which is what makes it a fair tiebreak rather
  // than a first-come one.
  bids.sort((a, b) => b.amountMinor - a.amountMinor || a.position - b.position);

  const queue = bids.filter((b) => b.meetsReserve && b.withinCap);
  return { bids, queue, winner: queue[0] ?? null, padding, discarded };
}
