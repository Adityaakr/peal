import { describe, expect, it } from 'vitest';
import {
  BidRecordError, MAX_AMOUNT_MINOR, MAX_NAME_BYTES, RECORD_BYTES, decodeBid, encodeBid,
} from '../src/record.js';

const AUCTION = 'cond_220d820315fb9ef12f73c8fb';

describe('the sealed bid record', () => {
  it('round trips a bid', () => {
    const bid = { auctionId: AUCTION, amountMinor: 125_00, name: 'ana' };
    expect(decodeBid(encodeBid(bid))).toEqual(bid);
  });

  it('is the same length for every bid it can hold', () => {
    // The reason this format exists. The FO body is a keystream XOR, so the
    // sealed blob is 69 + payload bytes; if the record tracked the amount, the
    // magnitude of a bid would be readable on the wire before the reveal.
    // Measured against the live coordinator: unpadded, "5" sealed to 100 base64
    // chars and "1000000000" to 112. Padded, both go to 228.
    const lengths = new Set(
      [
        { amountMinor: 1, name: '' },
        { amountMinor: 250, name: 'bo' },
        { amountMinor: MAX_AMOUNT_MINOR, name: 'x'.repeat(MAX_NAME_BYTES) },
        { amountMinor: 999, name: '🎈🎈🎈' },
      ].map((b) => encodeBid({ auctionId: AUCTION, ...b }).length),
    );
    expect([...lengths]).toEqual([RECORD_BYTES]);
  });

  it('carries a name of emoji up to the byte cap', () => {
    const name = '🎈'.repeat(MAX_NAME_BYTES / 4);
    expect(decodeBid(encodeBid({ auctionId: AUCTION, amountMinor: 5, name }))?.name).toBe(name);
  });

  it.each([
    ['a fractional amount', { amountMinor: 12.5, name: 'a' }],
    ['zero', { amountMinor: 0, name: 'a' }],
    ['a negative amount', { amountMinor: -1, name: 'a' }],
    ['an amount over the ceiling', { amountMinor: MAX_AMOUNT_MINOR + 1, name: 'a' }],
    ['a name past the byte cap', { amountMinor: 1, name: 'x'.repeat(MAX_NAME_BYTES + 1) }],
  ])('refuses %s', (_label, partial) => {
    expect(() => encodeBid({ auctionId: AUCTION, ...partial })).toThrow(BidRecordError);
  });

  it('refuses an auction id that leaves no room for the name', () => {
    expect(() =>
      encodeBid({ auctionId: 'x'.repeat(90), amountMinor: 1, name: 'ana' }),
    ).toThrow(BidRecordError);
  });

  it.each([
    ['the wrong length', (b: Uint8Array) => b.slice(0, RECORD_BYTES - 1)],
    ['an unknown version', (b: Uint8Array) => { b[0] = 2; return b; }],
    ['a zero length auction id', (b: Uint8Array) => { b[9] = 0; return b; }],
    ['an auction id running past the record', (b: Uint8Array) => { b[9] = 255; return b; }],
    ['a zero amount', (b: Uint8Array) => { b.fill(0, 1, 9); return b; }],
    ['bytes hidden in the padding', (b: Uint8Array) => { b[RECORD_BYTES - 1] = 7; return b; }],
  ])('rejects a record with %s', (_label, corrupt) => {
    const bytes = encodeBid({ auctionId: AUCTION, amountMinor: 42, name: 'ana' });
    expect(decodeBid(corrupt(bytes))).toBeNull();
  });

  it('rejects a name that is not valid utf-8', () => {
    const bytes = encodeBid({ auctionId: AUCTION, amountMinor: 42, name: 'ana' });
    bytes[11 + AUCTION.length] = 0xff;
    expect(decodeBid(bytes)).toBeNull();
  });
});

describe('text that does not survive its own encoding', () => {
  // TextEncoder maps every lone surrogate to U+FFFD, so distinct strings encode
  // to identical bytes. For a name that is untidy. For an auction id it is
  // load bearing: buildBoard compares the decoded id against the terms, so a
  // bid would be discarded as a replay of itself.
  it.each([['\uD800'], ['\uDFFF'], ['ana\uD83D']])('refuses the name %j', (name) => {
    expect(() => encodeBid({ auctionId: AUCTION, amountMinor: 1, name })).toThrow(BidRecordError);
  });

  it('refuses an auction id with an unpaired surrogate', () => {
    expect(() => encodeBid({ auctionId: `${AUCTION}\uD800`, amountMinor: 1, name: 'ana' }))
      .toThrow(BidRecordError);
  });

  it('still accepts properly paired astral characters', () => {
    const name = '🎈 ana';
    expect(decodeBid(encodeBid({ auctionId: AUCTION, amountMinor: 1, name }))?.name).toBe(name);
  });
});
