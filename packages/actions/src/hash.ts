/** sha256 over WebCrypto.
 *
 * Deliberately WebCrypto rather than a bundled hash library: this code runs in
 * the agent's browser tab and in Node, and both ship it. One implementation
 * means the hash an agent computes locally is bit-identical to the one the
 * coordinator checks.
 *
 * WebCrypto needs a secure context in the browser (https or localhost). That is
 * already true of everything Peal does client-side, since sealing needs it too.
 */

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Copy into a plain ArrayBuffer: a view over a SharedArrayBuffer is not a
  // BufferSource, and callers may hand us either.
  const input = new Uint8Array(new ArrayBuffer(data.length));
  input.set(data);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new Error('not a hex string');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(await sha256(data));
}

/** Constant-time-ish comparison for hex digests.
 *
 * Digest comparison is not usually a timing target — both sides are public by
 * the time you compare them — but receipt verification also compares a
 * signature-derived value, and having one comparison helper that is always safe
 * is cheaper than auditing which call sites need it. */
export function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
