/** The plaintext a bidder seals to the committee with batched threshold
 * encryption (BTE), via `BteClient.seal` in the browser.
 *
 * Everything the reveal needs travels inside the ciphertext, including the
 * salt. That is the whole point of sealing: once the payload is encrypted to
 * the committee, the bidder holds nothing that has to survive until the close.
 * Losing the browser loses nothing. Compare the earlier commit-only scheme,
 * where the salt existed only on the bidder's machine and a lost salt meant a
 * refund instead of an allocation.
 *
 * Domain separation lives inside the plaintext, per decisions/0002: `seal()`
 * takes no associated data, so the chain id, the auction and the bidder are
 * embedded here and checked after decryption. A ciphertext replayed from one
 * auction into another decrypts to a payload naming the wrong auction, and the
 * settler drops it.
 *
 * The encoding is `abi.encode` of the fields behind an 8-byte magic. Fixed
 * width, no dynamic types, so a payload is 8 + 7 * 32 = 232 bytes and any other
 * length is not a bid.
 */
import { decodeAbiParameters, encodeAbiParameters, hexToBytes, bytesToHex, type Address, type Hex } from 'viem';
import { type BidParams } from './commitment.js';

export type BidPayload = BidParams;

/** ASCII `PEALBID1`. The trailing digit is the payload version. */
export const BID_PAYLOAD_MAGIC = new Uint8Array([0x50, 0x45, 0x41, 0x4c, 0x42, 0x49, 0x44, 0x31]);

const FIELDS = [
  { type: 'uint256' }, // chainId
  { type: 'address' }, // auction
  { type: 'address' }, // bidder
  { type: 'uint256' }, // quantity
  { type: 'uint16' }, // maxPriceTick
  { type: 'bytes32' }, // salt
  { type: 'uint16' }, // bidVersion
] as const;

export const BID_PAYLOAD_BYTES = BID_PAYLOAD_MAGIC.length + FIELDS.length * 32;

export function encodeBidPayload(p: BidPayload): Uint8Array {
  if (p.maxPriceTick < 0 || p.maxPriceTick > 0xffff) throw new RangeError('maxPriceTick is uint16');
  if (p.bidVersion < 0 || p.bidVersion > 0xffff) throw new RangeError('bidVersion is uint16');
  if (p.quantity < 0n) throw new RangeError('quantity must be non-negative');
  if (!/^0x[0-9a-fA-F]{64}$/.test(p.salt)) throw new RangeError('salt must be 32 bytes');

  const body = hexToBytes(
    encodeAbiParameters(FIELDS, [
      BigInt(p.chainId),
      p.auction,
      p.bidder,
      p.quantity,
      p.maxPriceTick,
      p.salt,
      p.bidVersion,
    ]),
  );
  const out = new Uint8Array(BID_PAYLOAD_BYTES);
  out.set(BID_PAYLOAD_MAGIC, 0);
  out.set(body, BID_PAYLOAD_MAGIC.length);
  return out;
}

/** Null for anything that is not a well-formed bid payload. Never throws: the
 * settler feeds it every real slot of a batch, and a stray payload someone
 * sealed to the same condition must be skipped, not crash the reveal. */
export function decodeBidPayload(bytes: Uint8Array): BidPayload | null {
  if (bytes.length !== BID_PAYLOAD_BYTES) return null;
  for (let i = 0; i < BID_PAYLOAD_MAGIC.length; i += 1) {
    if (bytes[i] !== BID_PAYLOAD_MAGIC[i]) return null;
  }
  try {
    const [chainId, auction, bidder, quantity, maxPriceTick, salt, bidVersion] = decodeAbiParameters(
      FIELDS,
      bytesToHex(bytes.subarray(BID_PAYLOAD_MAGIC.length)),
    );
    if (chainId > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return {
      chainId: Number(chainId),
      auction: auction as Address,
      bidder: bidder as Address,
      quantity,
      maxPriceTick: Number(maxPriceTick),
      salt: salt as Hex,
      bidVersion: Number(bidVersion),
    };
  } catch {
    return null;
  }
}
