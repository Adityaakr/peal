import { describe, expect, it } from 'vitest';
import {
  MAX_CONTACT_BYTES, SEALED_CONTACT_BYTES, generateSellerKeys, isSellerKey, openContact,
  sealContact,
} from '../src/contact.js';

describe('a contact only the seller can read', () => {
  it('round trips', async () => {
    const keys = await generateSellerKeys();
    const sealed = await sealContact(keys.publicKey, '+91 98765 43210');
    expect(await openContact(keys.privateKey, sealed)).toBe('+91 98765 43210');
  });

  it('cannot be read with anybody else\'s key', async () => {
    // The whole point. Every other bidder sees this blob when the batch opens.
    const seller = await generateSellerKeys();
    const stranger = await generateSellerKeys();
    const sealed = await sealContact(seller.publicKey, 'ana@example.com');
    expect(await openContact(stranger.privateKey, sealed)).toBeNull();
  });

  it('is the same size whatever was written in it', async () => {
    const keys = await generateSellerKeys();
    const sizes = new Set<number>();
    for (const text of ['a', 'ana@example.com', 'x'.repeat(MAX_CONTACT_BYTES - 1)]) {
      sizes.add((await sealContact(keys.publicKey, text)).length);
    }
    // Otherwise the length of a blob everyone can see would leak how much was
    // written, which is the same mistake the bid record exists to avoid.
    expect([...sizes]).toEqual([SEALED_CONTACT_BYTES]);
  });

  it('is different bytes every time, even for the same text and key', async () => {
    // The ephemeral key is per bid, so two bids from one person cannot be tied
    // together by anything in the blob.
    const keys = await generateSellerKeys();
    const a = await sealContact(keys.publicKey, 'same');
    const b = await sealContact(keys.publicKey, 'same');
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
    expect(await openContact(keys.privateKey, a)).toBe('same');
    expect(await openContact(keys.privateKey, b)).toBe('same');
  });

  it('refuses text longer than the cap', async () => {
    const keys = await generateSellerKeys();
    await expect(sealContact(keys.publicKey, 'x'.repeat(MAX_CONTACT_BYTES + 1)))
      .rejects.toThrow(/exceed/);
  });

  it('carries unicode intact', async () => {
    const keys = await generateSellerKeys();
    const text = 'शून्य @ 🎈';
    expect(await openContact(keys.privateKey, await sealContact(keys.publicKey, text))).toBe(text);
  });

  it('returns null for a tampered blob rather than throwing', async () => {
    const keys = await generateSellerKeys();
    const sealed = await sealContact(keys.publicKey, 'ana@example.com');
    for (const i of [0, 70, sealed.length - 1]) {
      const bad = Uint8Array.from(sealed);
      bad[i] = bad[i]! ^ 0xff;
      expect(await openContact(keys.privateKey, bad)).toBeNull();
    }
    expect(await openContact(keys.privateKey, sealed.subarray(0, 10))).toBeNull();
    expect(await openContact(keys.privateKey, new Uint8Array(SEALED_CONTACT_BYTES))).toBeNull();
  });

  it('recognises a seller key, and refuses anything that is not one', async () => {
    const keys = await generateSellerKeys();
    expect(isSellerKey(keys.publicKey)).toBe(true);
    for (const bad of ['', 'nope', 'a'.repeat(88), '!!!!']) {
      expect(isSellerKey(bad)).toBe(false);
    }
  });

  it('has a public key short enough to ride in a link', async () => {
    const keys = await generateSellerKeys();
    // Terms are capped at 512 bytes by the name registry, so this has to be
    // small enough to leave room for the auction itself.
    expect(keys.publicKey.length).toBeLessThanOrEqual(90);
  });
});
