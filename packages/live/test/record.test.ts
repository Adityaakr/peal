import { describe, expect, it } from 'vitest';
import {
  BidRecordError, MAX_AMOUNT_MINOR, MAX_AUCTION_ID_BYTES, MAX_NAME_BYTES, RECORD_BYTES,
  decodeBid, encodeBid,
} from '../src/record.js';

const AUCTION = 'cond_220d820315fb9ef12f73c8fb';

describe('the sealed bid record', () => {
  it('round trips a bid', () => {
    const bid = { auctionId: AUCTION, amountMinor: 125_00, name: 'ana' };
    expect(decodeBid(encodeBid(bid))).toEqual({ ...bid, contact: null });
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

  it('refuses an auction id past the cap', () => {
    expect(() =>
      encodeBid({ auctionId: 'x'.repeat(MAX_AUCTION_ID_BYTES + 1), amountMinor: 1, name: 'ana' }),
    ).toThrow(BidRecordError);
  });

  it('fits the largest legal record, with everything at its maximum', () => {
    // The format has to hold the worst case, and that has to be checked rather
    // than assumed: the caps and the buffer size are set independently.
    const bytes = encodeBid({
      auctionId: 'x'.repeat(MAX_AUCTION_ID_BYTES),
      amountMinor: MAX_AMOUNT_MINOR,
      name: 'x'.repeat(MAX_NAME_BYTES),
      contact: new Uint8Array(157),
    });
    expect(bytes.length).toBe(RECORD_BYTES);
    expect(decodeBid(bytes)?.auctionId).toBe('x'.repeat(MAX_AUCTION_ID_BYTES));
  });

  it.each([
    ['the wrong length', (b: Uint8Array) => b.slice(0, RECORD_BYTES - 1)],
    ['an unknown version', (b: Uint8Array) => { b[0] = 9; return b; }],
    ['a zero length auction id', (b: Uint8Array) => { b[9] = 0; return b; }],
    ['an auction id past the cap', (b: Uint8Array) => { b[9] = 255; return b; }],
    ['an auction id one over the cap', (b: Uint8Array) => { b[9] = MAX_AUCTION_ID_BYTES + 1; return b; }],
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


describe('the sealed contact a record can carry', () => {
  const BLOB = Uint8Array.from({ length: 157 }, (_, i) => (i * 7) % 251);

  it('round trips the bytes untouched', () => {
    const out = decodeBid(encodeBid({ auctionId: AUCTION, amountMinor: 500, name: 'ana', contact: BLOB }));
    expect(out?.contact).toEqual(BLOB);
  });

  it('is the same record length whether or not one is attached', () => {
    // A record that grew when a contact was attached would announce on the wire
    // that one was, which is most of what a contact reveals.
    const withOne = encodeBid({ auctionId: AUCTION, amountMinor: 500, name: 'ana', contact: BLOB });
    const without = encodeBid({ auctionId: AUCTION, amountMinor: 500, name: 'ana' });
    expect(withOne.length).toBe(without.length);
    expect(withOne.length).toBe(RECORD_BYTES);
  });

  it('reads back as none when there was none', () => {
    expect(decodeBid(encodeBid({ auctionId: AUCTION, amountMinor: 1, name: 'a' }))?.contact).toBeNull();
    expect(decodeBid(encodeBid({ auctionId: AUCTION, amountMinor: 1, name: 'a', contact: null }))?.contact)
      .toBeNull();
  });

  it('rejects a record whose contact runs past the end', () => {
    const bytes = encodeBid({ auctionId: AUCTION, amountMinor: 1, name: 'ana' });
    bytes[11 + AUCTION.length + 3] = 255;
    // 255 bytes of contact cannot fit after everything else in 288.
    expect(decodeBid(bytes)).toBeNull();
  });

  it('still refuses bytes hidden in the padding after a contact', () => {
    const bytes = encodeBid({ auctionId: AUCTION, amountMinor: 1, name: 'ana', contact: BLOB });
    bytes[RECORD_BYTES - 1] = 7;
    expect(decodeBid(bytes)).toBeNull();
  });
});
