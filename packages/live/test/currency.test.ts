import { describe, expect, it } from 'vitest';
import { CURRENCIES, currencyLabel, findCurrency, searchCurrencies } from '../src/currency.js';
import { formatAmount, parseAmount } from '../src/amount.js';

describe('the currency table', () => {
  it('has no duplicate codes', () => {
    const codes = CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('has minor units the record can actually hold', () => {
    // Terms refuse decimals outside 0..4, so an entry outside that range would
    // be a currency nobody could create an auction in.
    for (const c of CURRENCIES) {
      expect(Number.isInteger(c.decimals)).toBe(true);
      expect(c.decimals).toBeGreaterThanOrEqual(0);
      expect(c.decimals).toBeLessThanOrEqual(4);
      expect(c.code.length).toBeLessThanOrEqual(12);
      expect(c.name).not.toBe('');
    }
  });

  // The reason this table exists rather than a hardcoded 2. Sealing a ¥1250 bid
  // as if the yen had cents opens it as ¥12.50.
  it.each([
    ['JPY', 0], ['KRW', 0], ['VND', 0], ['CLP', 0], ['ISK', 0],
    ['KWD', 3], ['BHD', 3], ['OMR', 3], ['JOD', 3], ['TND', 3],
    ['USD', 2], ['INR', 2], ['EUR', 2],
  ])('%s has %i minor units', (code, decimals) => {
    expect(findCurrency(code)?.decimals).toBe(decimals);
  });

  it('round trips an amount at every currency in the table', () => {
    for (const c of CURRENCIES) {
      const typed = c.decimals === 0 ? '1250' : `1250.${'1'.repeat(c.decimals)}`;
      const minor = parseAmount(typed, c.decimals);
      expect(formatAmount(minor, c.decimals)).toBe(
        c.decimals === 0 ? '1,250' : `1,250.${'1'.repeat(c.decimals)}`,
      );
    }
  });

  it('carries points, which is not money', () => {
    expect(findCurrency('points')?.decimals).toBe(0);
  });
});

describe('looking one up', () => {
  it('is case insensitive and tolerates spacing', () => {
    expect(findCurrency('inr')?.code).toBe('INR');
    expect(findCurrency('  InR  ')?.code).toBe('INR');
  });

  it('returns null for something it does not know, rather than a default', () => {
    // The field behind this is free text. Falling back to dollars would seal an
    // auction denominated in something the seller did not choose.
    expect(findCurrency('XYZ')).toBeNull();
    expect(findCurrency('')).toBeNull();
    expect(findCurrency('dollars')).toBeNull();
  });
});

describe('searching', () => {
  it('finds a currency by its code', () => {
    expect(searchCurrencies('inr')[0]?.code).toBe('INR');
  });

  it('finds one by its name', () => {
    expect(searchCurrencies('rupee').map((c) => c.code)).toContain('INR');
    expect(searchCurrencies('yen')[0]?.code).toBe('JPY');
  });

  it('finds one by its symbol', () => {
    expect(searchCurrencies('₹')[0]?.code).toBe('INR');
    expect(searchCurrencies('₩')[0]?.code).toBe('KRW');
  });

  it('puts a code match ahead of a name that merely contains the query', () => {
    // "in" is the start of INR and appears inside "Argentine peso".
    expect(searchCurrencies('in')[0]?.code).toBe('INR');
  });

  it('prefers an exact code over anything else', () => {
    expect(searchCurrencies('CAD')[0]?.code).toBe('CAD');
  });

  it('offers a starting set for an empty query', () => {
    expect(searchCurrencies('').length).toBeGreaterThan(0);
    expect(searchCurrencies('')[0]?.code).toBe('USD');
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchCurrencies('zzzzzz')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(searchCurrencies('', 3)).toHaveLength(3);
  });
});

describe('the label', () => {
  it('reads as code, name and symbol', () => {
    expect(currencyLabel(findCurrency('INR')!)).toBe('INR — Indian rupee ₹');
    expect(currencyLabel(findCurrency('CHF')!)).toBe('CHF — Swiss franc');
  });
});

describe('ties', () => {
  it('breaks on the table order, not the alphabet', () => {
    // "rup" matches both "Indian rupee" and "Indonesian rupiah". Alphabetically
    // IDR wins, which is not what somebody typing it usually means.
    expect(searchCurrencies('rup')[0]?.code).toBe('INR');
    expect(searchCurrencies('rup').map((c) => c.code)).toContain('IDR');
  });

  it('still puts a code prefix ahead of a name match', () => {
    expect(searchCurrencies('id')[0]?.code).toBe('IDR');
  });
});
