/** Contact details a bidder gives the seller, and nobody else.
 *
 * THE PROBLEM. Everything sealed into a bid becomes public when the batch
 * opens: that is what the reveal IS. So a "contact" field alongside the name
 * would be readable by every other bidder the moment the timer ran out. Hiding
 * it in the interface and calling it private would be the exact kind of claim
 * this product cannot afford to make.
 *
 * THE SHAPE. The seller gets a keypair when they create the auction. The public
 * half rides in the terms, so every bidder has it and it is covered by the
 * check code. The private half never leaves the device that made the auction.
 * A bidder encrypts to the public half; only the seller can undo it, and the
 * reveal publishes a blob that says nothing to anyone else.
 *
 * WHAT IS BEING USED. WebCrypto's own ECDH and AES-GCM, and its own `deriveKey`
 * to get from one to the other. No key derivation is written here: the browser
 * does it. This is the standard way to encrypt to a public key with the
 * primitives a browser already ships, not a construction invented for this.
 *
 * THE COST, WHICH IS REAL. The private key lives in one browser's storage. Lose
 * that browser and every contact detail becomes permanently unreadable, by
 * everyone, including the seller. There is no recovery and there cannot be one:
 * anything that let us recover it would let us read them.
 */

/** How much contact text a bidder may write. A phone number, a handle or an
 * email address; not a message. */
export const MAX_CONTACT_BYTES = 64;

/** Raw P-256 public key. */
const PUBLIC_KEY_BYTES = 65;
const IV_BYTES = 12;
/** AES-GCM's authentication tag. */
const TAG_BYTES = 16;

/** The fixed size of a sealed contact: an ephemeral public key, a nonce, and
 * the text with its tag. Fixed so a bid that carries a contact is the same
 * length as one that does not. */
export const SEALED_CONTACT_BYTES = PUBLIC_KEY_BYTES + IV_BYTES + MAX_CONTACT_BYTES + TAG_BYTES;

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface SellerKeys {
  /** Goes in the terms, so every bidder has it and the check code covers it. */
  publicKey: string;
  /** Stays on the device that created the auction. Nothing else can read a
   * contact without it, including us. */
  privateKey: JsonWebKey;
}

/** A keypair for one auction. */
export async function generateSellerKeys(): Promise<SellerKeys> {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    publicKey: b64(raw),
    privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
}

/** Whether a string is shaped like a seller's public key. Checked before it is
 * used, because it arrives inside a link a stranger sent. */
export function isSellerKey(key: string): boolean {
  try {
    return unb64(key.trim()).length === PUBLIC_KEY_BYTES;
  } catch {
    return false;
  }
}

/** Encrypt a contact so only the seller can read it.
 *
 * The ephemeral key is per bid and thrown away immediately, which is what stops
 * two bids from the same person being linkable by anything in the blob.
 */
export async function sealContact(sellerPublicKey: string, text: string): Promise<Uint8Array> {
  const plain = new TextEncoder().encode(text);
  if (plain.length > MAX_CONTACT_BYTES) {
    throw new Error(`contact details exceed ${MAX_CONTACT_BYTES} bytes`);
  }

  const seller = await crypto.subtle.importKey('raw', unb64(sellerPublicKey) as BufferSource, ECDH, false, []);
  const ephemeral = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
  const shared = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: seller },
    ephemeral.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  // Padded to the cap before encryption, so the length of the blob says nothing
  // about the length of what was written in it.
  const padded = new Uint8Array(MAX_CONTACT_BYTES);
  padded[0] = plain.length;
  padded.set(plain, 1);
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      shared,
      padded.subarray(0, MAX_CONTACT_BYTES) as BufferSource,
    ),
  );

  const ephRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const out = new Uint8Array(SEALED_CONTACT_BYTES);
  out.set(ephRaw, 0);
  out.set(iv, PUBLIC_KEY_BYTES);
  out.set(body, PUBLIC_KEY_BYTES + IV_BYTES);
  return out;
}

/** Read a contact back, with the key only the seller has.
 *
 * Returns null rather than throwing for anything that does not open. A board is
 * built from strangers' bids, and one unreadable blob must not stop the rest
 * from rendering.
 */
export async function openContact(
  privateKey: JsonWebKey,
  sealed: Uint8Array,
): Promise<string | null> {
  if (sealed.length !== SEALED_CONTACT_BYTES) return null;
  try {
    const mine = await crypto.subtle.importKey('jwk', privateKey, ECDH, false, ['deriveKey']);
    const theirs = await crypto.subtle.importKey(
      'raw',
      sealed.subarray(0, PUBLIC_KEY_BYTES) as BufferSource,
      ECDH,
      false,
      [],
    );
    const shared = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: theirs },
      mine,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const iv = sealed.subarray(PUBLIC_KEY_BYTES, PUBLIC_KEY_BYTES + IV_BYTES);
    const body = sealed.subarray(PUBLIC_KEY_BYTES + IV_BYTES);
    const padded = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        shared,
        body as BufferSource,
      ),
    );
    const len = padded[0] ?? 0;
    if (len === 0 || len > MAX_CONTACT_BYTES - 1) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(padded.subarray(1, 1 + len));
  } catch {
    return null;
  }
}
