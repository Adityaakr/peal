import { describe, expect, it } from 'vitest';
import { AmountError, formatAmount, parseAmount } from '../src/amount.js';

describe('parsing a typed amount', () => {
  it.each([
    ['12.50', 2, 1250],
    ['12.5', 2, 1250],
    ['12', 2, 1200],
    ['.5', 2, 50],
    ['0.01', 2, 1],
    ['1,250', 2, 125000],
    ['  42  ', 0, 42],
    ['12.1', 1, 121],
  ])('reads %s at %i decimals as %i minor units', (text, decimals, expected) => {
    expect(parseAmount(text, decimals)).toBe(expected);
  });

  it('does not go through a float', () => {
    // Math.round(12.10 * 100) is 1210 here but this class of expression is
    // where an amount comes back one minor unit off the one that was typed,
    // and on an auction board that is a wrong winner.
    for (let cents = 1; cents <= 2000; cents++) {
      const text = (cents / 100).toFixed(2);
      expect(parseAmount(text, 2)).toBe(cents);
    }
  });

  it.each([
    ['an empty string', '', 2],
    ['only spaces', '   ', 2],
    ['letters', '12abc', 2],
    ['a negative', '-5', 2],
    ['two dots', '1.2.3', 2],
    ['zero', '0', 2],
    ['zero with decimals', '0.00', 2],
    ['more decimals than the unit has', '1.234', 2],
    ['any decimals on a whole-number unit', '1.5', 0],
  ])('refuses %s', (_label, text, decimals) => {
    expect(() => parseAmount(text, decimals)).toThrow(AmountError);
  });

  it('refuses an amount too large to stay an exact integer', () => {
    expect(() => parseAmount('99999999999999999999', 2)).toThrow(AmountError);
  });
});

describe('formatting an amount', () => {
  it.each([
    [1250, 2, '12.50'],
    [1, 2, '0.01'],
    [0, 2, '0.00'],
    [42, 0, '42'],
    [123456789, 2, '1,234,567.89'],
    [1000000, 0, '1,000,000'],
  ])('renders %i at %i decimals as %s', (minor, decimals, expected) => {
    expect(formatAmount(minor, decimals)).toBe(expected);
  });

  it('round trips whatever parse produced', () => {
    for (const text of ['0.01', '12.50', '1234.05', '999999.99']) {
      expect(formatAmount(parseAmount(text, 2), 2)).toBe(
        Number(text).toLocaleString('en-US', { minimumFractionDigits: 2 }),
      );
    }
  });
});

describe('the comma', () => {
  // A comma is a decimal separator for most of the world. Stripping it made
  // "12,50" parse as 1250 major units, a hundred times the intended bid, and
  // the bid is sealed and cannot be taken back.
  it.each([
    ['12,50', 2],
    ['0,99', 2],
    ['1234,56', 2],
    ['1,25', 2],
  ])('refuses %s rather than reading it as a hundred times more', (text, decimals) => {
    expect(() => parseAmount(text, decimals)).toThrow(/use a dot for decimals/);
  });

  it.each([
    ['1,250', 125000],
    ['1,234,567', 123456700],
    ['1,250.75', 125075],
  ])('still accepts %s as a thousands separator', (text, expected) => {
    expect(parseAmount(text, 2)).toBe(expected);
  });

  it.each(['1,2,3', '12,345,6', ',500', '1,'])('refuses the malformed grouping %s', (text) => {
    expect(() => parseAmount(text, 2)).toThrow(AmountError);
  });
});

describe('the ceiling', () => {
  it('refuses an amount the sealed record could not hold, before anything is sealed', async () => {
    const { MAX_AMOUNT_MINOR } = await import('../src/record.js');
    expect(parseAmount(String(MAX_AMOUNT_MINOR), 0)).toBe(MAX_AMOUNT_MINOR);
    expect(() => parseAmount(String(MAX_AMOUNT_MINOR + 1), 0)).toThrow(AmountError);
    // The value that used to get through parse and then throw an encoder error
    // into the UI after "sealing" had already started.
    expect(() => parseAmount('2000000000000', 2)).toThrow(AmountError);
  });
});
