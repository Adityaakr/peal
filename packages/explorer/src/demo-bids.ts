// Recovering the seeded demo bids from public data.
//
// The demo auction was seeded by `contracts/script/SeedDemoBids.s.sol`, which
// derives every bidder key and every salt from a published string:
//
//     salt_i   = keccak256(abi.encodePacked("peal-demo-salt-",   uint256(i)))
//     bidder_i = addr(keccak256(abi.encodePacked("peal-demo-bidder-", uint256(i))))
//
// That was deliberate, so anyone can reproduce the demo and drive the reveal
// without trusting whoever ran the script. But it has a consequence the
// interface has to state plainly: **those four bids are readable by anyone,
// right now.** A salt is the only thing standing between a commitment and its
// contents, and these salts are in a public file.
//
// So rather than render them as "hidden until close", the page recomputes each
// commitment from the published parameters and, when it matches what is
// onchain, says so and shows the contents. A sealed-bid interface that labelled
// a readable bid "sealed" would be teaching exactly the wrong lesson about what
// sealing does.
//
// Nothing here applies to a bid a real user places: those salts come from
// `crypto.getRandomValues` and exist only in that browser.
import { bidCommitment } from 'peal-auctionkit';
import { concat, keccak256, stringToHex, toHex, type Address, type Hex } from 'viem';

/** The bid parameters `SeedDemoBids.s.sol:48-53` publishes. */
const SEEDED: { quantity: bigint; tick: number }[] = [
  { quantity: 120_000n * 10n ** 18n, tick: 18 },
  { quantity: 300_000n * 10n ** 18n, tick: 12 },
  { quantity: 450_000n * 10n ** 18n, tick: 7 },
  { quantity: 260_000n * 10n ** 18n, tick: 2 },
];

/** `abi.encodePacked(string, uint256)` then keccak, matching the script. */
function derived(prefix: string, i: number): Hex {
  return keccak256(concat([stringToHex(prefix), toHex(BigInt(i), { size: 32 })]));
}

export function demoSalt(i: number): Hex {
  return derived('peal-demo-salt-', i);
}

export interface RecoveredBid {
  quantity: bigint;
  tick: number;
  salt: Hex;
  /** Which seeded index it matched. */
  index: number;
}

/**
 * Try to recover a bid's contents from published data.
 *
 * Returns null for any bid that is genuinely sealed, which is every bid a real
 * user places. The check is a recomputation, not a lookup: it only claims a bid
 * is readable when the published parameters actually reproduce the commitment
 * that is onchain.
 */
export function recoverSeededBid(args: {
  chainId: number;
  auction: Address;
  bidder: Address;
  commitment: Hex;
}): RecoveredBid | null {
  for (const [index, spec] of SEEDED.entries()) {
    const salt = demoSalt(index);
    const candidate = bidCommitment({
      chainId: args.chainId,
      auction: args.auction,
      bidder: args.bidder,
      quantity: spec.quantity,
      maxPriceTick: spec.tick,
      salt,
      bidVersion: 1,
    });
    if (candidate.toLowerCase() === args.commitment.toLowerCase()) {
      return { quantity: spec.quantity, tick: spec.tick, salt, index };
    }
  }
  return null;
}
