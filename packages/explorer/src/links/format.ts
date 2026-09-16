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

/** A short, human sentence for an error from the wallet, the chain or the
 * node. Raw library errors carry calldata and stack-like detail that a
 * person cannot act on; the first line and a few known cases are enough. */
export function describeError(e: unknown, chainName?: string, chainId?: number): string {
  const raw = e instanceof Error ? e.message : String(e);
  const first = raw.split('\n')[0]?.trim() ?? raw;
  if (/rejected|denied/i.test(raw)) return 'You declined the request in your wallet. Nothing was sent.';
  const mismatch = /current chain of the wallet \(id: (\d+)\)/i.exec(raw);
  if (mismatch) {
    return `Your wallet is on chain ${mismatch[1]}. Switch it to ${chainName ?? 'the request\u2019s chain'}${chainId ? ` (id ${chainId})` : ''} and try again.`;
  }
  if (/insufficient funds|InsufficientBalance|exceeds the balance/i.test(raw)) return 'Your wallet does not hold enough tokens (or gas) for this transaction.';
  if (/not reachable/i.test(raw)) return 'The Peal Links node is not reachable. Try again in a moment.';
  return first.length > 200 ? `${first.slice(0, 200)}\u2026` : first;
}
