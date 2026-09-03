/** Turning what a bidder typed into what the auction ranks.
 *
 * A seller picks one currency and the whole auction is denominated in it: the
 * reserve, the ceiling, the board, the winner. A bidder in Kathmandu should
 * still be able to think in rupees, so they type in theirs and it is converted
 * once, here, before the bid is sealed.
 *
 * WHAT IS COMMITTED IS THE CONVERTED NUMBER. The rate is applied at the moment
 * of bidding, shown to the bidder before they commit, and sealed with the bid.
 * Converting later instead, when the auction opens, would make the winner
 * depend on a rate fetched at viewing time: two people opening the same reveal
 * an hour apart could rank the same bids differently, and the board would stop
 * being reproducible from the reveal alone. Everything else about this product
 * rests on that reproducibility.
 *
 * SO THE RATE IS A CONVENIENCE, NOT A GUARANTEE. It comes from a third party
 * and nothing on chain attests to it. What the auction can prove is what was
 * committed, in the auction's own currency. The interface says the converted
 * figure is the bid, and shows it before anything is sealed, so nobody commits
 * to a number they were not shown.
 */

/** Rates quoted against one base currency, as `code -> units per 1 base`. */
export interface RateTable {
  base: string;
  rates: Record<string, number>;
  /** When the provider last recomputed these, ISO 8601. Shown to bidders,
   * because a rate with no date is a number with no meaning. */
  asOf: string;
}

export class RateError extends Error {}

/** Units of `to` for one unit of `from`.
 *
 * Both are quoted against the table's base, so this is one division. Returns
 * null when either side is missing rather than guessing, because a wrong rate
 * here is a wrong bid.
 */
export function crossRate(table: RateTable, from: string, to: string): number | null {
  if (from === to) return 1;
  const a = table.rates[from];
  const b = table.rates[to];
  if (!isUsable(a) || !isUsable(b)) return null;
  return b! / a!;
}

function isUsable(n: number | undefined): boolean {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** Convert minor units of one currency into minor units of another.
 *
 * Rounds to the NEAREST whole minor unit, because a bid is an integer of minor
 * units and there is nowhere to put a fraction of a cent. Not "half up": the
 * arithmetic is binary floating point, so an exact half rarely exists to round
 * (1.00 at a rate of 1.005 computes as 100.4999..., and goes down). At a sub
 * minor unit that is immaterial next to a rate quoted to six figures, and the
 * alternative is decimal arithmetic for no gain a bidder could observe.
 *
 * Whichever way it lands is visible: the interface shows this exact number
 * before the bid is sealed, so the bidder commits to what they were shown
 * rather than to something computed again later.
 */
export function convertMinor(
  amountMinor: number,
  fromDecimals: number,
  toDecimals: number,
  rate: number,
): number {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new RateError('amount must be a whole number of minor units');
  }
  if (!isUsable(rate)) throw new RateError('that exchange rate is not usable');

  const major = amountMinor / 10 ** fromDecimals;
  const converted = major * rate * 10 ** toDecimals;
  if (!Number.isFinite(converted)) throw new RateError('that conversion overflowed');
  return Math.round(converted);
}

/** How old a table may be before a bidder should be told.
 *
 * The provider republishes daily, so anything inside about a day is simply the
 * current rate. Past that the number on screen is stale and saying so is the
 * difference between a convenience and a misleading one.
 */
export const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

export function isStale(table: RateTable, now = Date.now()): boolean {
  const at = Date.parse(table.asOf);
  if (!Number.isFinite(at)) return true;
  return now - at > STALE_AFTER_MS;
}

/** Whether a table can price this pair at all. */
export function canConvert(table: RateTable | null, from: string, to: string): boolean {
  if (from === to) return true;
  return table !== null && crossRate(table, from, to) !== null;
}
