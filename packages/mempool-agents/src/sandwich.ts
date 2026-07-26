// The searcher's decision, in bigint against the live pool reserves.
//
// Same result as the off-chain model in the explorer (mempool/amm.ts): the
// sandwich is bounded by the victim's slippage floor, not the searcher's
// appetite. The searcher front-runs to exactly the amount that pushes the
// victim to its minOut and no further, because any more reverts the victim's
// swap and the whole atomic bundle with it. Small swaps are left alone: the
// 0.3% fee on both of the searcher's legs eats the edge.

const FEE_NUM = 997n;
const FEE_DEN = 1000n;

/**
 * Headroom the searcher leaves under the victim's revert floor, in basis points.
 *
 * The bisection below finds the largest front-run that still clears minOut
 * against the reserves read a moment ago. The sandwich is atomic, so if the
 * pool moves at all between that read and inclusion, the victim's leg reverts
 * and takes the whole bundle down with it. A reverted bundle leaves the order
 * sitting unexecuted in PublicBuilder.pending, which is exactly the state that
 * strands the demo's public lane. Sizing to a floor a few bps above minOut
 * costs the searcher a sliver of profit and survives ordinary drift.
 */
const MARGIN_BPS = 5n;

/** Matches SwapPool.getAmountOut exactly (integer division, truncating). */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n) return 0n;
  const inWithFee = amountIn * FEE_NUM;
  return (reserveOut * inWithFee) / (reserveIn * FEE_DEN + inWithFee);
}

export interface Reserves {
  base: bigint;
  quote: bigint;
}

/** Reserves as seen by the swap direction: (in, out). */
function forDir(r: Reserves, baseToQuote: boolean): [bigint, bigint] {
  return baseToQuote ? [r.base, r.quote] : [r.quote, r.base];
}

/** The victim's output if the searcher front-runs with `frontIn` first. */
function victimOutAfterFront(
  r: Reserves,
  baseToQuote: boolean,
  victimIn: bigint,
  frontIn: bigint,
): bigint {
  const [rIn, rOut] = forDir(r, baseToQuote);
  const frontOut = getAmountOut(frontIn, rIn, rOut);
  return getAmountOut(victimIn, rIn + frontIn, rOut - frontOut);
}

export interface SandwichPlan {
  worthIt: boolean;
  /** Input-token amount for the front-run leg. */
  frontIn: bigint;
  /** Searcher profit in the victim's input token, at that size. */
  profit: bigint;
}

/**
 * The size a rational searcher picks, and whether it bothers.
 *
 * victimOut is monotonically decreasing in frontIn, so bisect for the largest
 * frontIn that still clears `minOut`. Then price the round trip; if the fee
 * makes it unprofitable, the searcher passes.
 */
export function planSandwich(
  r: Reserves,
  baseToQuote: boolean,
  victimIn: bigint,
  minOut: bigint,
): SandwichPlan {
  const [rIn, rOut] = forDir(r, baseToQuote);

  // Bisect the revert wall, held MARGIN_BPS above the victim's actual floor so
  // a small reserve move before inclusion does not revert the bundle.
  const floor = minOut + (minOut * MARGIN_BPS) / 10_000n;
  let lo = 0n;
  let hi = rIn; // an absurd upper bound; the wall is far below it
  for (let i = 0; i < 256 && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n;
    if (victimOutAfterFront(r, baseToQuote, victimIn, mid) >= floor) lo = mid;
    else hi = mid;
  }
  const frontIn = lo;

  // Price the full round trip at that front-run size.
  const frontOut = getAmountOut(frontIn, rIn, rOut);
  const rInAfterFront = rIn + frontIn;
  const rOutAfterFront = rOut - frontOut;
  const victimOut = getAmountOut(victimIn, rInAfterFront, rOutAfterFront);
  const rInAfterVictim = rInAfterFront + victimIn;
  const rOutAfterVictim = rOutAfterFront - victimOut;
  // Back-run unwinds frontOut in the opposite direction.
  const backOut = getAmountOut(frontOut, rOutAfterVictim, rInAfterVictim);
  const profit = backOut - frontIn;

  return { worthIt: frontIn > 0n && profit > 0n, frontIn, profit };
}
