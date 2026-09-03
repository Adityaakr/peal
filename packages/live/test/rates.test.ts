import { describe, expect, it } from 'vitest';
import {
  RateError, STALE_AFTER_MS, canConvert, convertMinor, crossRate, isStale, type RateTable,
} from '../src/rates.js';
import { decodeBid, encodeBid } from '../src/record.js';

const TABLE: RateTable = {
  base: 'USD',
  // Real figures from open.er-api.com, so the arithmetic below is checkable
  // against something that existed.
  rates: { USD: 1, EUR: 0.863349, NPR: 151.837523, INR: 94.892446, JPY: 159.088772 },
  asOf: '2026-09-03T00:02:31Z',
};

describe('pricing a bid in the bidder\'s own currency', () => {
  it('crosses two currencies through the base', () => {
    expect(crossRate(TABLE, 'USD', 'NPR')).toBeCloseTo(151.837523, 6);
    expect(crossRate(TABLE, 'NPR', 'USD')).toBeCloseTo(1 / 151.837523, 9);
    // EUR -> NPR never touches a quoted pair; it is two divisions.
    expect(crossRate(TABLE, 'EUR', 'NPR')).toBeCloseTo(151.837523 / 0.863349, 6);
  });

  it('is exactly 1 for a currency against itself, without consulting the table', () => {
    expect(crossRate(TABLE, 'USD', 'USD')).toBe(1);
    // Even one the table has never heard of: no conversion is happening.
    expect(crossRate(TABLE, 'XYZ', 'XYZ')).toBe(1);
    expect(canConvert(null, 'XYZ', 'XYZ')).toBe(true);
  });

  it('refuses a pair it cannot price rather than guessing one', () => {
    // A wrong rate here is a wrong bid, so there is no fallback to 1.
    expect(crossRate(TABLE, 'USD', 'ZWL')).toBeNull();
    expect(crossRate(TABLE, 'ZWL', 'USD')).toBeNull();
    expect(canConvert(TABLE, 'USD', 'ZWL')).toBe(false);
    expect(canConvert(null, 'USD', 'EUR')).toBe(false);
  });

  it('refuses a rate that is zero, negative or not a number', () => {
    const broken: RateTable = { ...TABLE, rates: { USD: 1, AAA: 0, BBB: -2, CCC: NaN } };
    for (const code of ['AAA', 'BBB', 'CCC']) {
      expect(crossRate(broken, 'USD', code)).toBeNull();
    }
  });

  it('converts between currencies with different minor units', () => {
    // 100.00 USD into NPR, which also has two.
    expect(convertMinor(100_00, 2, 2, 151.837523)).toBe(15_183_75);
    // 1000 JPY, which has none, into USD, which has two.
    expect(convertMinor(1000, 0, 2, 1 / 159.088772)).toBe(629);
    // And back the other way, losing the sub-yen remainder as it must.
    expect(convertMinor(629, 2, 0, 159.088772)).toBe(1001);
  });

  it('rounds to the nearest whole minor unit, never to a fraction of one', () => {
    expect(convertMinor(100, 2, 2, 1.004)).toBe(100);
    expect(convertMinor(100, 2, 2, 1.006)).toBe(101);
    expect(convertMinor(0, 2, 2, 2)).toBe(0);
    // Everything it returns is a whole number, across a spread of awkward
    // rates. This is the property that matters; which side an exact tie falls
    // is binary floating point and not something a bidder can observe.
    for (const rate of [0.000123, 1.005, 3.14159, 151.837523, 99999.5]) {
      for (const amount of [1, 7, 100, 12_345, 1_000_000]) {
        expect(Number.isInteger(convertMinor(amount, 2, 2, rate))).toBe(true);
      }
    }
  });

  it('refuses an amount that is not whole minor units', () => {
    expect(() => convertMinor(1.5, 2, 2, 1)).toThrow(RateError);
    expect(() => convertMinor(-1, 2, 2, 1)).toThrow(RateError);
    expect(() => convertMinor(100, 2, 2, 0)).toThrow(RateError);
    expect(() => convertMinor(100, 2, 2, Number.NaN)).toThrow(RateError);
  });

  it('calls a table stale once it is older than the provider republishes', () => {
    const at = Date.parse(TABLE.asOf);
    expect(isStale(TABLE, at + 1000)).toBe(false);
    expect(isStale(TABLE, at + STALE_AFTER_MS - 1)).toBe(false);
    expect(isStale(TABLE, at + STALE_AFTER_MS + 1)).toBe(true);
    // A table with no usable date is stale: a rate with no date means nothing.
    expect(isStale({ ...TABLE, asOf: 'whenever' }, at)).toBe(true);
  });
});

describe('what a converted bid carries into the record', () => {
  const AUCTION = 'cond_220d820315fb9ef12f73c8fb';

  it('ranks on the auction currency and remembers what was typed', () => {
    // 10,000.00 NPR bid into a USD auction.
    const rate = crossRate(TABLE, 'NPR', 'USD')!;
    const committed = convertMinor(10_000_00, 2, 2, rate);
    expect(committed).toBe(65_86);

    const back = decodeBid(encodeBid({
      auctionId: AUCTION,
      amountMinor: committed,
      name: 'ana',
      origin: { code: 'NPR', amountMinor: 10_000_00, decimals: 2 },
    }))!;

    // The board sorts on this one.
    expect(back.amountMinor).toBe(65_86);
    // And can show this one beside it.
    expect(back.origin).toEqual({ code: 'NPR', amountMinor: 10_000_00, decimals: 2 });
  });

  it('says nothing at all when the bidder used the auction currency', () => {
    const back = decodeBid(encodeBid({ auctionId: AUCTION, amountMinor: 100, name: 'ana' }))!;
    expect(back.origin).toBeNull();
  });
});
