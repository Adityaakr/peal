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
