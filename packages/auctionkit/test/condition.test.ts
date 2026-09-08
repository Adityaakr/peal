import { describe, expect, it } from 'vitest';
import { keccak256, stringToHex } from 'viem';
import { conditionIdFromEpoch, epochFromConditionId, isConditionId } from '../src/condition.js';

const ID = 'cond_0123456789abcdef01234567';

describe('encryptionEpoch <-> condition id', () => {
  it('round-trips a coordinator id through bytes32', () => {
    const epoch = epochFromConditionId(ID);
    expect(epoch).toMatch(/^0x[0-9a-f]{64}$/);
    // 29 ASCII bytes then three zero bytes.
    expect(epoch.endsWith('000000')).toBe(true);
    expect(conditionIdFromEpoch(epoch)).toBe(ID);
  });

  it('refuses to encode anything that is not a condition id', () => {
    expect(() => epochFromConditionId('cond_short')).toThrow(RangeError);
    expect(() => epochFromConditionId('live_0123456789abcdef01234567')).toThrow(RangeError);
    expect(() => epochFromConditionId('cond_0123456789ABCDEF01234567')).toThrow(RangeError);
    expect(isConditionId(ID)).toBe(true);
  });

  it('returns null for the epochs older auctions carry', () => {
    // What auction-create.ts wrote before sealing was wired in.
    expect(conditionIdFromEpoch(keccak256(stringToHex('name:usecase:1700000000')))).toBeNull();
    expect(conditionIdFromEpoch(`0x${'0'.repeat(64)}`)).toBeNull();
    expect(conditionIdFromEpoch(`0x${'ff'.repeat(32)}`)).toBeNull();
    // Right shape, wrong content: printable but not an id.
    expect(conditionIdFromEpoch(stringToHex('hello, this is not a condition'.padEnd(32, '\0')))).toBeNull();
  });

  it('never throws on malformed hex', () => {
    expect(conditionIdFromEpoch('0x1234' as `0x${string}`)).toBeNull();
    expect(conditionIdFromEpoch('nonsense' as `0x${string}`)).toBeNull();
  });
});
