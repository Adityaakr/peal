/** Private seals: an extra AES-GCM layer whose key travels ONLY in the share
 * link's hash fragment (never sent to any server). The network still proves
 * WHEN the seal opened; only people holding the full link learn WHAT.
 * Payload wire format: "BTEP1" + iv (12 bytes) + AES-128-GCM ciphertext. */

const MAGIC = [0x42, 0x54, 0x45, 0x50, 0x31]; // "BTEP1"

export function isPrivatePayload(bytes: Uint8Array): boolean {
  return bytes.length > MAGIC.length + 12 && MAGIC.every((b, i) => bytes[i] === b);
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Bytes variant, for sealing a file rather than a line of text. The text
 * helpers below are thin wrappers over these two. */
export async function encryptPrivateBytes(
  data: Uint8Array,
): Promise<{ payload: Uint8Array; key: string }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // Copy into an ArrayBuffer-backed view: a Uint8Array over a SharedArrayBuffer
  // is not a BufferSource, and the caller's array may be either.
  const input = new Uint8Array(new ArrayBuffer(data.length));
  input.set(data);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, input));
  const payload = new Uint8Array(MAGIC.length + iv.length + ct.length);
  payload.set(MAGIC, 0);
  payload.set(iv, MAGIC.length);
  payload.set(ct, MAGIC.length + iv.length);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  return { payload, key: b64urlEncode(raw) };
}

/** Returns the plaintext, or null when the key is wrong or the bytes are not
 * a private payload. */
export async function decryptPrivate(bytes: Uint8Array, keyB64u: string): Promise<string | null> {
  if (!isPrivatePayload(bytes)) return null;
  try {
    const raw = b64urlDecode(keyB64u);
    const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
    const copy = new Uint8Array(new ArrayBuffer(bytes.length));
    copy.set(bytes);
    const iv = copy.slice(MAGIC.length, MAGIC.length + 12);
    const ct = copy.slice(MAGIC.length + 12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
