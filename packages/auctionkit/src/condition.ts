/** The link between an auction and the Peal condition its bids are sealed to.
 *
 * `SealedBidAuction.Config.encryptionEpoch` is a bytes32 the contract folds into
 * the reveal-root digest and otherwise never interprets. AuctionKit uses it to
 * carry the coordinator's condition id verbatim: a condition id is
 * `cond_` plus 24 hex characters, 29 ASCII bytes, so it fits in 32 bytes with
 * three zero bytes of padding.
 *
 * Carrying the id itself, rather than a hash of it, is what lets a bidder's
 * browser go from the on-chain config straight to the condition it must seal
 * to, with no lookup table and no trust in whoever served the page. It also
 * binds the reveal root to the condition: the digest the committee signs
 * includes the epoch, so a root signed for one condition cannot be replayed
 * against an auction sealed to another.
 *
 * Auctions created before this convention hold an arbitrary hash in the field.
 * `conditionIdFromEpoch` returns null for those, and callers must treat such
 * an auction as one that cannot take a sealed bid, never fall back to a
 * bidder-held secret.
 */
import { bytesToHex, hexToBytes, type Hex } from 'viem';

/** What the coordinator issues: `new_id("cond")` in bte-coordinator/state.rs. */
const CONDITION_ID = /^cond_[0-9a-f]{24}$/;

export function isConditionId(id: string): boolean {
  return CONDITION_ID.test(id);
}

/** The bytes32 to put in `Config.encryptionEpoch` for an auction sealed to `id`. */
export function epochFromConditionId(id: string): Hex {
  if (!CONDITION_ID.test(id)) {
    throw new RangeError(`not a coordinator condition id: ${JSON.stringify(id)}`);
  }
  const ascii = new TextEncoder().encode(id);
  const out = new Uint8Array(32);
  out.set(ascii);
  return bytesToHex(out);
}

/** The condition an auction is sealed to, or null when the epoch does not carry
 * one (an auction created before sealing was wired in, or by another client). */
export function conditionIdFromEpoch(epoch: Hex): string | null {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(epoch);
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  // Every byte of a valid id is printable ASCII, so any high bit means this is
  // a hash, not an id. Checked before decoding so a stray multi-byte sequence
  // cannot decode to something the regex happens to accept.
  for (let i = 0; i < end; i += 1) {
    if (bytes[i]! < 0x20 || bytes[i]! > 0x7e) return null;
  }
  const id = new TextDecoder().decode(bytes.subarray(0, end));
  return CONDITION_ID.test(id) ? id : null;
}
