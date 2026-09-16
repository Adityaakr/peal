// Amount formatting for Peal Links. Base units in, strings out, bigint only.

/** Format `units` (a decimal string of base units) with `decimals` places,
 * grouping the integer part and trimming trailing zeros down to a minimum
 * of two fractional digits. Throws on a non-integer input. */
export function formatUnits(units: string, decimals: number, minFraction = 2): string {
  if (!/^\d+$/.test(units)) throw new Error(`not an integer amount: ${units}`);
  const value = BigInt(units);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = value % scale;
  const wholeText = whole.toLocaleString('en-US');
  if (decimals === 0) return wholeText;
  let fracText = frac.toString().padStart(decimals, '0');
  fracText = fracText.replace(/0+$/, '');
  if (fracText.length < minFraction) fracText = fracText.padEnd(minFraction, '0');
  return fracText.length ? `${wholeText}.${fracText}` : wholeText;
}

/** Parse a user-typed decimal amount into base units. Returns null when the
 * text is not a valid amount or has more fractional digits than allowed. */
export function parseUnits(text: string, decimals: number): string | null {
  const m = /^\s*(\d+)(?:\.(\d*))?\s*$/.exec(text);
  if (!m) return null;
  const whole = m[1]!;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  const scaled = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  return scaled.toString();
}

export function shortHex(s: string, head = 6, tail = 4): string {
  const clean = s.startsWith('0x') ? s.slice(2) : s;
  if (clean.length <= head + tail + 1) return s;
  return `${s.startsWith('0x') ? '0x' : ''}${clean.slice(0, head)}…${clean.slice(-tail)}`;
}

export function fmtTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
