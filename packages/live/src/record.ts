/** The bytes that actually get sealed for one bid.
 *
 * Every record is exactly RECORD_BYTES long, and that is the whole point.
 * The FO ciphertext body is a keystream XOR over the plaintext
 * (crates/bte-crypto/src/lib.rs:125, ct2 is a Vec<u8>), so the sealed blob is
 * `69 + payload` bytes. Sealing the digits of a bid directly therefore puts its
 * magnitude on the wire in the clear: measured against the live coordinator,
 * "5" sealed to 100 base64 chars, "250" to 104 and "1000000000" to 112. Padding
 * to a fixed width put all three at 228.
 *
 * This is a length policy over an existing cipher, not a new construction.
 *
 * The layout is binary rather than JSON because JSON's overhead left roughly
 * fourteen bytes for a display name inside the same budget, and because a
 * fixed-width record has to have exactly one encoding of any given bid.
 *
 *   [0]                     version, 1
 *   [1..9)                  amount in minor units, u64 big endian
 *   [9]                     auction id length in bytes
 *   [10 .. 10+idLen)        auction id, utf-8
 *   [10+idLen]              display name length in bytes
 *   [.. +nameLen)           display name, utf-8
 *   [.. RECORD_BYTES)       zero padding
 */

export const RECORD_VERSION = 1;
export const RECORD_BYTES = 96;

/** Bids are integers of minor units, so no bid can carry a rounding error.
 * The ceiling keeps the value inside the exactly-representable integer range
 * once it comes back out of a u64 as a number. */
export const MAX_AMOUNT_MINOR = 1_000_000_000_000;

/** Enough for a stream handle, and it has to be a byte cap rather than a
 * character one: twenty four emoji are ninety six bytes and would not fit. */
export const MAX_NAME_BYTES = 48;

export interface Bid {
  /** The coordinator condition this bid was sealed for. Carried INSIDE the
   * sealed bytes on purpose: a ciphertext is not bound to a condition
   * (SECURITY.md:38-42), so a blob posted to one auction can be replayed into
   * another and will decrypt to the same payload. Checking this at reveal is
   * what makes that replay detectable. */
  auctionId: string;
  /** Integer minor units, so 12.50 in a 2-decimal unit is 1250. */
  amountMinor: number;
  /** What the bidder wants to be called on the board. Never unique, never
   * trusted, and never used to decide anything. */
  name: string;
}

/** A lone half of a surrogate pair.
 *
 * TextEncoder replaces every one of these with U+FFFD, so two different names
 * encode to identical bytes and a name does not survive its own round trip.
 * That is merely untidy for a display name and load bearing for an auction id,
 * which buildBoard compares against the terms: a bid whose id contains a lone
 * surrogate encodes to something that no longer equals the id it was made for,
 * and gets discarded as a replay of itself. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });

export class BidRecordError extends Error {}

function fail(why: string): never {
  throw new BidRecordError(why);
}

/** Encode a bid into exactly RECORD_BYTES bytes, ready to seal. */
export function encodeBid(bid: Bid): Uint8Array {
  if (!Number.isInteger(bid.amountMinor)) fail('amount must be an integer of minor units');
  if (bid.amountMinor <= 0) fail('amount must be positive');
  if (bid.amountMinor > MAX_AMOUNT_MINOR) fail(`amount exceeds ${MAX_AMOUNT_MINOR}`);

  if (LONE_SURROGATE.test(bid.auctionId)) fail('auction id is not valid text');
  if (LONE_SURROGATE.test(bid.name)) fail('that name contains an unpaired character');

  const id = utf8.encode(bid.auctionId);
  const name = utf8.encode(bid.name);
  if (id.length === 0) fail('auction id is required');
  if (id.length > 255) fail('auction id is too long');
  if (name.length > MAX_NAME_BYTES) fail(`name exceeds ${MAX_NAME_BYTES} bytes`);

  const used = 10 + id.length + 1 + name.length;
  if (used > RECORD_BYTES) fail(`record needs ${used} bytes, the format holds ${RECORD_BYTES}`);

  const out = new Uint8Array(RECORD_BYTES);
  const view = new DataView(out.buffer);
  out[0] = RECORD_VERSION;
  view.setBigUint64(1, BigInt(bid.amountMinor), false);
  out[9] = id.length;
  out.set(id, 10);
  out[10 + id.length] = name.length;
  out.set(name, 11 + id.length);
  return out;
}

/** Decode a revealed payload back into a bid.
 *
 * Returns null rather than throwing for anything malformed. A reveal is a batch
 * of payloads from strangers, and one unparseable slot must not be able to stop
 * the board from rendering. Every rejection here is a bid that does not count.
 */
export function decodeBid(bytes: Uint8Array): Bid | null {
  if (bytes.length !== RECORD_BYTES) return null;
  if (bytes[0] !== RECORD_VERSION) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const amount = view.getBigUint64(1, false);
  if (amount <= 0n || amount > BigInt(MAX_AMOUNT_MINOR)) return null;

  const idLen = bytes[9]!;
  if (idLen === 0) return null;
  const nameLenAt = 10 + idLen;
  if (nameLenAt >= RECORD_BYTES) return null;
  const nameLen = bytes[nameLenAt]!;
  const end = nameLenAt + 1 + nameLen;
  if (nameLen > MAX_NAME_BYTES || end > RECORD_BYTES) return null;

  // Padding must be zero. Otherwise one bid has many encodings, which would
  // make the record a place to smuggle bytes past a board that only shows a
  // name and a number.
  for (let i = end; i < RECORD_BYTES; i++) if (bytes[i] !== 0) return null;

  try {
    return {
      auctionId: fromUtf8.decode(bytes.subarray(10, 10 + idLen)),
      amountMinor: Number(amount),
      name: fromUtf8.decode(bytes.subarray(nameLenAt + 1, end)),
    };
  } catch {
    return null;
  }
}
