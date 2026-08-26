import { describe, expect, it } from 'vitest';
import { BID_COMMITMENT_TYPEHASH, bidCommitment, randomSalt, revealLeaf } from '../src/commitment.js';

/** Printed by `forge test --match-contract CommitmentVectors -vv`, i.e. by the
 * contract that will actually recompute this at reveal time. If this test fails
 * after a contract change, every bid the client builds would be voided — fix
 * the client, do not repin the vector. */
const VECTOR = {
  chainId: 560048,
  auction: '0x1111111111111111111111111111111111111111',
  bidder: '0x2222222222222222222222222222222222222222',
  quantity: 1234567890123456789n,
  maxPriceTick: 7,
  salt: `0x${'abcdef'.padStart(64, '0')}`,
  bidVersion: 1,
} as const;
const EXPECTED = '0xec596cc140308e6e9e8d5bd3ccb9502270ce715b51e4552fdc4672c523ae4156';

describe('bidCommitment', () => {
  it('matches the vector the contract printed', () => {
    expect(bidCommitment({ ...VECTOR })).toBe(EXPECTED);
  });

  it('pins the typehash', () => {
    expect(BID_COMMITMENT_TYPEHASH).toBe(
      '0x66506436939e49c7d3412445ca329256c8e8cd1f163206f4442a9a295b241b14',
    );
  });

  it('binds every field', () => {
    const base = bidCommitment({ ...VECTOR });
    const variants = [
      { ...VECTOR, chainId: 1 },
      { ...VECTOR, auction: '0x1111111111111111111111111111111111111112' as const },
      { ...VECTOR, bidder: '0x2222222222222222222222222222222222222223' as const },
      { ...VECTOR, quantity: VECTOR.quantity + 1n },
      { ...VECTOR, maxPriceTick: 8 },
      { ...VECTOR, salt: `0x${'1'.repeat(64)}` as const },
      { ...VECTOR, bidVersion: 2 },
    ];
    for (const [i, v] of variants.entries()) {
      expect(bidCommitment(v), `variant ${i} left the commitment unchanged`).not.toBe(base);
    }
  });

  it('rejects out-of-range values rather than silently truncating', () => {
    expect(() => bidCommitment({ ...VECTOR, maxPriceTick: 65_536 })).toThrow(RangeError);
    expect(() => bidCommitment({ ...VECTOR, bidVersion: -1 })).toThrow(RangeError);
    expect(() => bidCommitment({ ...VECTOR, quantity: -1n })).toThrow(RangeError);
    expect(() => bidCommitment({ ...VECTOR, salt: '0xdeadbeef' as never })).toThrow(RangeError);
  });
});

describe('randomSalt', () => {
  it('is 32 bytes and does not repeat', () => {
    const seen = new Set(Array.from({ length: 256 }, () => randomSalt()));
    expect(seen.size).toBe(256);
    for (const s of seen) expect(s).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('revealLeaf', () => {
  it('is order-sensitive in its fields', () => {
    const a = revealLeaf(0, 10n, 1, `0x${'11'.repeat(32)}`);
    const b = revealLeaf(1, 10n, 1, `0x${'11'.repeat(32)}`);
    const c = revealLeaf(0, 1n, 10, `0x${'11'.repeat(32)}`);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
