/** The uniform-price clearing algorithm, mirrored from `ClearingPrice.sol`.
 *
 * This exists so a bidder can be shown what their bid would win *before* they
 * sign, and so an interface can preview an outcome without an RPC round trip.
 *
 * It is a mirror, not the authority. `SealedBidAuction.finalize` computes the
 * real result on-chain, and this must agree with it exactly or the preview is a
 * lie. `test/clearing.test.ts` pins the same vectors the Solidity tests use.
 *
 * Every bidder pays the *clearing* price, not their own maximum. That is the
 * point of a uniform-price auction: bidding your true valuation cannot make you
 * overpay, so there is no reason to shade a bid.
 */

export interface ClearingResult {
  cleared: boolean;
  clearingTick: number;
  supplySold: bigint;
  demandAtClearingTick: bigint;
  supplyForClearingTick: bigint;
}

export const MAX_TICKS = 256;

const EMPTY: ClearingResult = {
  cleared: false,
  clearingTick: 0,
  supplySold: 0n,
  demandAtClearingTick: 0n,
  supplyForClearingTick: 0n,
};

/** Find the clearing tick from bucketed demand. Index 0 is the reserve price. */
export function findClearingTick(demandByTick: readonly bigint[], supply: bigint): ClearingResult {
  const numTicks = demandByTick.length;
  if (numTicks === 0 || numTicks > MAX_TICKS) throw new RangeError('bad tick count');
  if (supply <= 0n) throw new RangeError('zero supply');

  let cumulative = 0n;

  // High to low. A bid clears if the demand at or above its tick reaches supply.
  for (let tick = numTicks - 1; tick >= 0; tick--) {
    const demandHere = demandByTick[tick] ?? 0n;
    const cumulativeBefore = cumulative;
    cumulative += demandHere;

    if (cumulative >= supply) {
      return {
        cleared: true,
        clearingTick: tick,
        supplySold: supply,
        demandAtClearingTick: demandHere,
        // Bids strictly above took `cumulativeBefore`; the rest is shared here.
        supplyForClearingTick: supply - cumulativeBefore,
      };
    }
  }

  // Undersubscribed. Everything eligible fills, and it fills at the RESERVE —
  // not at the lowest tick anyone bid. Clearing at the lowest bid would let a
  // single lowball bid set the price for the whole book.
  if (cumulative === 0n) return { ...EMPTY };

  const atReserve = demandByTick[0] ?? 0n;
  return {
    cleared: true,
    clearingTick: 0,
    supplySold: cumulative,
    demandAtClearingTick: atReserve,
    supplyForClearingTick: atReserve,
  };
}

/** Allocation for one bid.
 *
 * Order-independent by construction: computed from the bid's own quantity and
 * two totals fixed at finalization, never from a running counter. A running
 * "remaining supply" would make allocation depend on who claims first. */
export function allocationFor(result: ClearingResult, bidQuantity: bigint, bidTick: number): bigint {
  if (!result.cleared) return 0n;
  if (bidTick < result.clearingTick) return 0n;
  if (bidTick > result.clearingTick) return bidQuantity;

  if (result.demandAtClearingTick <= result.supplyForClearingTick) return bidQuantity;
  // Pro-rata, floored — matches OZ `Math.mulDiv(..., Rounding.Floor)`.
  return (bidQuantity * result.supplyForClearingTick) / result.demandAtClearingTick;
}

/** Price at a tick, in quote base units per whole sale token. */
export function priceAt(reservePrice: bigint, tickSize: bigint, tick: number): bigint {
  return reservePrice + BigInt(tick) * tickSize;
}

/** What a bid actually pays. Floors, so the protocol never over-charges. */
export function costFloor(quantity: bigint, price: bigint, saleDecimals: number): bigint {
  return (quantity * price) / 10n ** BigInt(saleDecimals);
}

/** Escrow a bid must post: its quantity at its own maximum price.
 *
 * Ceils. The deposit must cover the worst case — a deposit one base unit short
 * is a settlement that reverts, or worse, one that succeeds by taking the
 * shortfall from another bidder's escrow. */
export function escrowFor(
  quantity: bigint,
  reservePrice: bigint,
  tickSize: bigint,
  maxTick: number,
  saleDecimals: number,
): bigint {
  const price = priceAt(reservePrice, tickSize, maxTick);
  const denom = 10n ** BigInt(saleDecimals);
  const n = quantity * price;
  return n === 0n ? 0n : (n + denom - 1n) / denom;
}
