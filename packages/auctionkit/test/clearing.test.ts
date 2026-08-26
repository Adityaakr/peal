import { describe, expect, it } from 'vitest';
import {
  allocationFor,
  costFloor,
  escrowFor,
  findClearingTick,
  priceAt,
} from '../src/clearing.js';

const ONE = 10n ** 18n;
const SALE_DECIMALS = 18;

describe('findClearingTick — the reference example from ClearingPrice.t.sol', () => {
  // A: 50 @ tick 2 (2.00), B: 70 @ tick 1 (1.50), C: 100 @ tick 0 (1.00)
  const demand = [100n * ONE, 70n * ONE, 50n * ONE];
  const supply = 100n * ONE;

  it('clears at tick 1 and sells everything', () => {
    const r = findClearingTick(demand, supply);
    expect(r.cleared).toBe(true);
    expect(r.clearingTick).toBe(1);
    expect(r.supplySold).toBe(100n * ONE);
  });

  it('allocates exactly as the contract does', () => {
    const r = findClearingTick(demand, supply);
    expect(allocationFor(r, 50n * ONE, 2)).toBe(50n * ONE); // above: full fill
    expect(allocationFor(r, 70n * ONE, 1)).toBe(50n * ONE); // at: 70 chases 50
    expect(allocationFor(r, 100n * ONE, 0)).toBe(0n); // below: nothing
  });

  it('charges both winners the same clearing price, not their maximums', () => {
    const r = findClearingTick(demand, supply);
    const price = priceAt(1_000_000n, 500_000n, r.clearingTick); // 6-dp quote
    expect(price).toBe(1_500_000n);
    expect(costFloor(50n * ONE, price, SALE_DECIMALS)).toBe(75_000_000n);
  });
});

describe('edge cases the contract is explicit about', () => {
  it('an empty book does not clear, rather than clearing at zero', () => {
    expect(findClearingTick([0n, 0n, 0n], 100n * ONE).cleared).toBe(false);
  });

  it('undersubscribed clears at the RESERVE, not at the lowest bid tick', () => {
    // Demand only at tick 2, well under supply.
    const r = findClearingTick([0n, 0n, 10n * ONE], 100n * ONE);
    expect(r.cleared).toBe(true);
    expect(r.clearingTick).toBe(0);
    expect(r.supplySold).toBe(10n * ONE);
  });

  it('pro-rata is independent of claim order', () => {
    const r = findClearingTick([0n, 300n * ONE], 100n * ONE);
    const a = allocationFor(r, 100n * ONE, 1);
    const b = allocationFor(r, 200n * ONE, 1);
    expect(a).toBe(33333333333333333333n);
    expect(b).toBe(66666666666666666666n);
    // Never over-allocates: floored shares cannot exceed the supply.
    expect(a + b).toBeLessThanOrEqual(100n * ONE);
  });

  it('rejects a tick count outside bounds', () => {
    expect(() => findClearingTick([], 1n)).toThrow(RangeError);
    expect(() => findClearingTick(new Array(257).fill(0n), 1n)).toThrow(RangeError);
  });
});

describe('escrow vs settlement rounding', () => {
  it('escrow rounds up, settlement rounds down, and the gap favours the bidder', () => {
    // Deliberately indivisible.
    const qty = 333_333_333_333_333_333n;
    const reserve = 1_000_001n;
    const tick = 3;
    const tickSize = 500_001n;

    const escrow = escrowFor(qty, reserve, tickSize, tick, SALE_DECIMALS);
    const paid = costFloor(qty, priceAt(reserve, tickSize, tick), SALE_DECIMALS);
    expect(escrow).toBeGreaterThanOrEqual(paid);
    expect(escrow - paid).toBeLessThanOrEqual(1n);
  });

  it('escrow always covers what settlement can charge, across many inputs', () => {
    for (let tick = 0; tick < 32; tick++) {
      for (const qty of [1n, 7n, ONE, 12_345_678_901_234_567n]) {
        const escrow = escrowFor(qty, 1_000_001n, 500_001n, tick, SALE_DECIMALS);
        const paid = costFloor(qty, priceAt(1_000_001n, 500_001n, tick), SALE_DECIMALS);
        expect(escrow).toBeGreaterThanOrEqual(paid);
      }
    }
  });
});
