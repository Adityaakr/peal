import { describe, expect, it } from 'vitest';
import { ctHashOf, sealedBytes } from '../src/ciphertext.js';

describe('deriving a ciphertext hash', () => {
  it('is sha256 over the bytes', async () => {
    // The empty digest, so this pins the algorithm rather than restating it.
    expect(await ctHashOf(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('changes when a single byte changes', async () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 4]);
    expect(await ctHashOf(a)).not.toBe(await ctHashOf(b));
  });

  it('round trips a base64 blob', () => {
    expect(sealedBytes(btoa('hello'))).toEqual(new TextEncoder().encode('hello'));
  });

  it('returns null for a blob that is not base64', () => {
    expect(sealedBytes('!!!!')).toBeNull();
  });
});

describe('the receipt code', () => {
  it('is the first six characters, upper cased', async () => {
    const { receiptCode } = await import('../src/ciphertext.js');
    expect(receiptCode('3893e8be0c91aa11bb22cc33dd44ee55ff66007711882299aabbccdd4e507ee1'))
      .toBe('3893E8');
  });

  it('has no letters that can be confused, because hex has no O or I', async () => {
    const { receiptCode } = await import('../src/ciphertext.js');
    for (const h of ['0123456789abcdef'.repeat(4), 'ffffff' + 'a'.repeat(58)]) {
      expect(receiptCode(h)).toMatch(/^[0-9A-F]{6}$/);
    }
  });

  it('distinguishes the bids in one batch', async () => {
    const { ctHashOf, receiptCode } = await import('../src/ciphertext.js');
    // Sixty four is the batch size, so that is the number it has to separate.
    const codes = new Set<string>();
    for (let i = 0; i < 64; i++) {
      codes.add(receiptCode(await ctHashOf(new Uint8Array([i, i + 1, i + 2]))));
    }
    expect(codes.size).toBe(64);
  });
});
