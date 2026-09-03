/** Turning what someone types into an integer, and back.
 *
 * Bids are integers of minor units everywhere else in this package. Parsing is
 * done on the decimal string rather than through a float, because
 * `Math.round(12.10 * 100)` is a class of bug that shows up as a bid one minor
 * unit off the one that was typed, and on an auction board that is a wrong
 * winner rather than a rounding artifact.
 */

import { MAX_AMOUNT_MINOR } from './record.js';

export class AmountError extends Error {}

/** Commas are only ever thousands separators here.
 *
 * Stripping every comma before parsing looks harmless and is not: half the
 * world writes twelve fifty as "12,50", and stripping the comma turns it into
 * 1250 major units, a hundred times the intended bid. The bid is then sealed
 * and cannot be taken back. So a comma is accepted only where a thousands
 * separator can actually go, and "12,50" is an error rather than a fortune. */
const THOUSANDS = /^\d{1,3}(,\d{3})+(\.\d*)?$/;

/** Parse a typed amount into minor units. Throws with a message meant to be
 * shown to the person who typed it. */
export function parseAmount(text: string, decimals: number): number {
  const typed = text.trim();
  if (!typed) throw new AmountError('enter an amount');
  if (typed.includes(',')) {
    if (!THOUSANDS.test(typed)) throw new AmountError('use a dot for decimals');
  }
  const raw = typed.replace(/,/g, '');
  if (!/^\d*(\.\d*)?$/.test(raw)) throw new AmountError('numbers only');

  const [whole = '', frac = ''] = raw.split('.');
  if (!whole && !frac) throw new AmountError('enter an amount');
  if (frac.length > decimals) {
    throw new AmountError(
      decimals === 0 ? 'whole numbers only' : `at most ${decimals} decimal place${decimals === 1 ? '' : 's'}`,
    );
  }
  const minor = Number(`${whole || '0'}${frac.padEnd(decimals, '0')}`);
  if (!Number.isSafeInteger(minor)) throw new AmountError('that amount is too large');
  if (minor <= 0) throw new AmountError('enter an amount above zero');
  // The same ceiling the sealed record enforces, checked here so an amount that
  // cannot be sealed is refused while it is still being typed rather than
  // surfacing as an encoder error after "sealing" has already started.
  if (minor > MAX_AMOUNT_MINOR) throw new AmountError('that amount is too large');
  return minor;
}

/** Render minor units for display. Never used to decide anything. */
export function formatAmount(minor: number, decimals: number): string {
  const sign = minor < 0 ? '-' : '';
  const digits = String(Math.abs(minor)).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals > 0 ? `.${digits.slice(digits.length - decimals)}` : '';
  return `${sign}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac}`;
}
