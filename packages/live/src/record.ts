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
 *   [0]                     version, 2
 *   [1..9)                  amount in minor units, u64 big endian
 *   [9]                     auction id length in bytes
 *   [10 .. 10+idLen)        auction id, utf-8
 *   [10+idLen]              display name length in bytes
 *   [.. +nameLen)           display name, utf-8
 *   [+0]                    sealed contact length, 0 when there is none
 *   [.. +contactLen)        the contact, encrypted to the seller's key
 *   [.. RECORD_BYTES)       zero padding
 */

export const RECORD_VERSION = 2;
/** Every record is this long, in every auction, whether or not it carries
 * contact details. A record that grew when a contact was attached would say on
 * the wire that one was, which is most of what a contact reveals. */
export const RECORD_BYTES = 288;

/** Bids are integers of minor units, so no bid can carry a rounding error.
 * The ceiling keeps the value inside the exactly-representable integer range
 * once it comes back out of a u64 as a number. */
export const MAX_AMOUNT_MINOR = 1_000_000_000_000;

/** Enough for a stream handle, and it has to be a byte cap rather than a
 * character one: twenty four emoji are ninety six bytes and would not fit. */
export const MAX_NAME_BYTES = 48;

/** The longest auction id the format will carry, matching MAX_AUCTION_ID_CHARS
 * in the terms.
 *
 * Bounded here rather than left to the record's own size. While a record was 96
 * bytes an id length of 255 could not fit and was rejected for that reason; at
 * 288 it fits, and a record claiming one would have decoded to an id of
 * whatever happened to be in the padding. A length that is only rejected as a
 * side effect of the buffer being small is not a rule, and it stopped being
 * true the moment the buffer grew. */
export const MAX_AUCTION_ID_BYTES = 64;

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
  /** Contact details, already encrypted to the seller's key. Null when the
   * auction did not ask for any.
   *
   * Encrypted before it gets here, on purpose: this record is published in full
   * when the batch opens, so anything readable in it is readable by every other
   * bidder. See contact.ts. */
  contact?: Uint8Array | null;
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
  if (id.length > MAX_AUCTION_ID_BYTES) fail('auction id is too long');
  if (name.length > MAX_NAME_BYTES) fail(`name exceeds ${MAX_NAME_BYTES} bytes`);

  const contact = bid.contact ?? null;
  if (contact && contact.length > 255) fail('sealed contact is too long');

  const used = 10 + id.length + 1 + name.length + 1 + (contact ? contact.length : 0);
  if (used > RECORD_BYTES) fail(`record needs ${used} bytes, the format holds ${RECORD_BYTES}`);

  const out = new Uint8Array(RECORD_BYTES);
  const view = new DataView(out.buffer);
  out[0] = RECORD_VERSION;
  view.setBigUint64(1, BigInt(bid.amountMinor), false);
  out[9] = id.length;
  out.set(id, 10);
  out[10 + id.length] = name.length;
  out.set(name, 11 + id.length);
  const contactAt = 11 + id.length + name.length;
  out[contactAt] = contact ? contact.length : 0;
  if (contact) out.set(contact, contactAt + 1);
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
  if (idLen === 0 || idLen > MAX_AUCTION_ID_BYTES) return null;
  const nameLenAt = 10 + idLen;
  if (nameLenAt >= RECORD_BYTES) return null;
  const nameLen = bytes[nameLenAt]!;
  const nameEnd = nameLenAt + 1 + nameLen;
  if (nameLen > MAX_NAME_BYTES || nameEnd >= RECORD_BYTES) return null;

  const contactLen = bytes[nameEnd]!;
  const end = nameEnd + 1 + contactLen;
  if (end > RECORD_BYTES) return null;

  // Padding must be zero. Otherwise one bid has many encodings, which would
  // make the record a place to smuggle bytes past a board that only shows a
  // name and a number.
  for (let i = end; i < RECORD_BYTES; i++) if (bytes[i] !== 0) return null;

  try {
    return {
      auctionId: fromUtf8.decode(bytes.subarray(10, 10 + idLen)),
      amountMinor: Number(amount),
      name: fromUtf8.decode(bytes.subarray(nameLenAt + 1, nameEnd)),
      contact: contactLen === 0 ? null : bytes.slice(nameEnd + 1, end),
    };
  } catch {
    return null;
  }
}
