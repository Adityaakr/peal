/** The bid commitment, recomputed off-chain.
 *
 * A bidder must produce this *before* submitting, since `commitBid` takes it as
 * an argument. If this disagrees with `SealedBidAuction.bidCommitment` by even a
 * byte, the bid becomes unrevealable: the contract recomputes it at reveal and
 * voids anything that does not match. The bidder would get a refund and no
 * allocation, with no error at commit time to warn them.
 *
 * That is why `test/commitment.test.ts` pins a vector printed by the contract
 * itself rather than trusting two implementations of the same `abi.encode` to
 * agree.
 *
 * Note this is a keccak over abi.encode with a typehash — the same shape as an
 * EIP-712 struct hash, but NOT wrapped in `\x19\x01 || domainSeparator`. It is
 * never signed; the chain id and auction address are folded into the struct
 * directly to bind it to one auction on one chain.
 */
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from 'viem';

/** keccak256 of the struct signature. Pinned so a contract-side change to the
 * field list fails a test here instead of silently voiding every bid. */
export const BID_COMMITMENT_TYPEHASH: Hex =
  '0x66506436939e49c7d3412445ca329256c8e8cd1f163206f4442a9a295b241b14';

export interface BidParams {
  chainId: number;
  auction: Address;
  bidder: Address;
  /** Sale-token base units. Never whole tokens: a whole-token quantity cannot
   * express a partial allocation. */
  quantity: bigint;
  /** Index into the auction's price ladder, not a price. */
  maxPriceTick: number;
  /** 32 random bytes. This is what stops an observer from confirming a guessed
   * bid by recomputing the commitment — without it, the commitment is a
   * searchable hash over a small space of plausible (quantity, tick) pairs. */
  salt: Hex;
  bidVersion: number;
}

export function bidCommitment(p: BidParams): Hex {
  if (p.maxPriceTick < 0 || p.maxPriceTick > 0xffff) throw new RangeError('maxPriceTick is uint16');
  if (p.bidVersion < 0 || p.bidVersion > 0xffff) throw new RangeError('bidVersion is uint16');
  if (p.quantity < 0n) throw new RangeError('quantity must be non-negative');
  if (!/^0x[0-9a-fA-F]{64}$/.test(p.salt)) throw new RangeError('salt must be 32 bytes');

  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint16' },
        { type: 'bytes32' },
        { type: 'uint16' },
      ],
      [
        BID_COMMITMENT_TYPEHASH,
        BigInt(p.chainId),
        p.auction,
        p.bidder,
        p.quantity,
        p.maxPriceTick,
        p.salt,
        p.bidVersion,
      ],
    ),
  );
}

/** The reveal leaf, `keccak256(keccak256(abi.encode(...)))`.
 *
 * Double-hashed, matching the contract: it is the standard defence against a
 * leaf being reinterpreted as an internal node of the tree. */
export function revealLeaf(bidId: number, quantity: bigint, tick: number, salt: Hex): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: 'uint32' }, { type: 'uint256' }, { type: 'uint16' }, { type: 'bytes32' }],
      [bidId, quantity, tick, salt],
    ),
  );
  return keccak256(inner);
}

/** A fresh salt. Uses the platform CSPRNG; there is no fallback to `Math.random`
 * on purpose, because a predictable salt silently removes the only thing hiding
 * a bid whose plausible values an attacker could enumerate. */
export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}
