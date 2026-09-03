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
 *   [0]                     version, 3
 *   [1..9)                  amount in minor units, u64 big endian
 *   [9]                     auction id length in bytes
 *   [10 .. 10+idLen)        auction id, utf-8
 *   [10+idLen]              display name length in bytes
 *   [.. +nameLen)           display name, utf-8
 *   [+0]                    sealed contact length, 0 when there is none
 *   [.. +contactLen)        the contact, encrypted to the seller's key
 *   [.. ORIGIN_AT)          zero padding
 *   [ORIGIN_AT .. +3)       the currency the bidder typed in, or three zero
 *                           bytes when they used the auction's own
 *   [+3 .. +11)             what they typed, minor units of THAT currency
 *   [+11]                   that currency's decimals
 *
 * THE AMOUNT AT [1..9) IS ALWAYS IN THE AUCTION'S CURRENCY, and it is the only
 * number the board ranks on. A bidder anywhere may type in their own currency,
 * but what they COMMIT is the converted figure, fixed at the moment they bid
 * and sealed with the bid.
 *
 * The alternative, sealing the foreign amount and converting when the auction
 * opens, would mean the winner depended on a rate fetched at viewing time: two
 * people opening the same reveal an hour apart could see different winners, and
 * the board would stop being reproducible from the reveal alone. That property
 * is worth more than sparing a bidder a rate they can see before they commit.
 *
 * The origin block is therefore for display and for the seller's records. It
 * sits at a fixed offset rather than after the variable-length contact so its
 * bounds are constants, and all-zero means the bidder used the auction's own
 * currency and no conversion happened.
 */

export const RECORD_VERSION = 3;

/** Version 2, still decoded. Auctions are permanent links and one may be
 * running right now; its bids are 288 bytes with no origin block, and refusing
 * them would empty a live board. Nothing writes this version any more. */
const RECORD_VERSION_V2 = 2;
const RECORD_BYTES_V2 = 288;
/** Every record is this long, in every auction, whether or not it carries
 * contact details. A record that grew when a contact was attached would say on
 * the wire that one was, which is most of what a contact reveals. */
export const RECORD_BYTES = 320;

/** Where the origin block starts. Twelve bytes: three of currency code, eight
 * of amount, one of decimals. */
const ORIGIN_BYTES = 12;
const ORIGIN_AT = RECORD_BYTES - ORIGIN_BYTES;

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
  /** What the bidder actually typed, when they typed it in a currency other
   * than the auction's. Null when they used the auction's own.
   *
   * Never ranked on. `amountMinor` above is what was committed and what the
   * board sorts by; this is here so the board can show "EUR 100" beside it and
   * so the seller knows what a bidder believes they promised. */
  origin?: BidOrigin | null;
}

/** The bid as its bidder wrote it, before conversion. */
export interface BidOrigin {
  /** ISO 4217, three uppercase letters. */
  code: string;
  /** Integer minor units of `code`, not of the auction's currency. */
  amountMinor: number;
  /** Minor units of `code`, so the record describes itself and does not depend
   * on a table that could be corrected later. */
  decimals: number;
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

  const origin = bid.origin ?? null;
  if (origin) {
    if (!/^[A-Z]{3}$/.test(origin.code)) fail('a currency code is three uppercase letters');
    if (!Number.isInteger(origin.amountMinor) || origin.amountMinor <= 0) {
      fail('the amount you typed must be a positive integer of minor units');
    }
    if (origin.amountMinor > MAX_AMOUNT_MINOR) fail(`amount exceeds ${MAX_AMOUNT_MINOR}`);
    if (!Number.isInteger(origin.decimals) || origin.decimals < 0 || origin.decimals > 4) {
      fail('decimals must be an integer from 0 to 4');
    }
  }

  const used = 10 + id.length + 1 + name.length + 1 + (contact ? contact.length : 0);
  // Against ORIGIN_AT rather than RECORD_BYTES: the last twelve bytes belong to
  // the origin block whether or not this bid fills them.
  if (used > ORIGIN_AT) fail(`record needs ${used} bytes, the format holds ${ORIGIN_AT}`);

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

  if (origin) {
    for (let i = 0; i < 3; i++) out[ORIGIN_AT + i] = origin.code.charCodeAt(i);
    view.setBigUint64(ORIGIN_AT + 3, BigInt(origin.amountMinor), false);
    out[ORIGIN_AT + 11] = origin.decimals;
  }
  return out;
}

/** Decode a revealed payload back into a bid.
 *
 * Returns null rather than throwing for anything malformed. A reveal is a batch
 * of payloads from strangers, and one unparseable slot must not be able to stop
 * the board from rendering. Every rejection here is a bid that does not count.
 */
export function decodeBid(bytes: Uint8Array): Bid | null {
  // Version 2 is still read, so an auction that was already running when the
  // format changed keeps its board. Its records are shorter and carry no origin
  // block; everything else about them is identical.
  const v2 = bytes[0] === RECORD_VERSION_V2 && bytes.length === RECORD_BYTES_V2;
  const v3 = bytes[0] === RECORD_VERSION && bytes.length === RECORD_BYTES;
  if (!v2 && !v3) return null;
  const padEnd = v2 ? RECORD_BYTES_V2 : ORIGIN_AT;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const amount = view.getBigUint64(1, false);
  if (amount <= 0n || amount > BigInt(MAX_AMOUNT_MINOR)) return null;

  const idLen = bytes[9]!;
  if (idLen === 0 || idLen > MAX_AUCTION_ID_BYTES) return null;
  const nameLenAt = 10 + idLen;
  if (nameLenAt >= padEnd) return null;
  const nameLen = bytes[nameLenAt]!;
  const nameEnd = nameLenAt + 1 + nameLen;
  if (nameLen > MAX_NAME_BYTES || nameEnd >= padEnd) return null;

  const contactLen = bytes[nameEnd]!;
  const end = nameEnd + 1 + contactLen;
  if (end > padEnd) return null;

  // Padding must be zero. Otherwise one bid has many encodings, which would
  // make the record a place to smuggle bytes past a board that only shows a
  // name and a number.
  for (let i = end; i < padEnd; i++) if (bytes[i] !== 0) return null;

  let origin: BidOrigin | null = null;
  if (!v2) {
    const parsed = readOrigin(bytes, view);
    if (parsed === INVALID) return null;
    origin = parsed;
  }

  try {
    return {
      auctionId: fromUtf8.decode(bytes.subarray(10, 10 + idLen)),
      amountMinor: Number(amount),
      name: fromUtf8.decode(bytes.subarray(nameLenAt + 1, nameEnd)),
      contact: contactLen === 0 ? null : bytes.slice(nameEnd + 1, end),
      origin,
    };
  } catch {
    return null;
  }
}

/** Distinguishes "there is no origin block" from "the origin block is wrong",
 * which must be rejected rather than quietly dropped: a record with garbage in
 * those bytes is not a record anyone wrote with this encoder. */
const INVALID = Symbol('invalid origin');

function readOrigin(bytes: Uint8Array, view: DataView): BidOrigin | null | typeof INVALID {
  const code = bytes.subarray(ORIGIN_AT, ORIGIN_AT + 3);
  const empty = code[0] === 0 && code[1] === 0 && code[2] === 0;

  if (empty) {
    // No conversion happened, so the whole block must be zero. Anything else is
    // a second encoding of the same bid.
    for (let i = ORIGIN_AT + 3; i < RECORD_BYTES; i++) if (bytes[i] !== 0) return INVALID;
    return null;
  }

  for (const c of code) if (c < 0x41 || c > 0x5a) return INVALID;
  const amount = view.getBigUint64(ORIGIN_AT + 3, false);
  if (amount <= 0n || amount > BigInt(MAX_AMOUNT_MINOR)) return INVALID;
  const decimals = bytes[ORIGIN_AT + 11]!;
  if (decimals > 4) return INVALID;

  return {
    code: String.fromCharCode(code[0]!, code[1]!, code[2]!),
    amountMinor: Number(amount),
    decimals,
  };
}
