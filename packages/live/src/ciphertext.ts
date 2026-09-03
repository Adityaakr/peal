/** Deriving a ciphertext's own name, in the browser.
 *
 * `client.seal()` returns the hash the COORDINATOR computed
 * (packages/sdk/src/index.ts:206), and every anchor and every receipt in this
 * repo has taken that value on trust. It does not have to: the browser is still
 * holding the ciphertext bytes it just made, and a content address is only
 * sha256 over them (`SealedCiphertext::hash`, crates/bte-crypto/src/lib.rs:130,
 * over the same `to_bytes()` that `seal` returns).
 *
 * So this is one WebCrypto call, no wasm and no new dependency, and it turns
 * "the coordinator says your bid is in" into something the page checked.
 * Verified against the live coordinator: three payloads, three exact matches.
 */
export async function ctHashOf(sealed: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', sealed as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decode a base64 ciphertext blob. Returns null rather than throwing, since
 * the input is whatever came back over the wire. */
export function sealedBytes(sealedB64: string): Uint8Array | null {
  try {
    const bin = atob(sealedB64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
