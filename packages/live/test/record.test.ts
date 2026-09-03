import { describe, expect, it } from 'vitest';
import {
  BidRecordError, MAX_AMOUNT_MINOR, MAX_AUCTION_ID_BYTES, MAX_NAME_BYTES, RECORD_BYTES,
  decodeBid, encodeBid,
} from '../src/record.js';

const AUCTION = 'cond_220d820315fb9ef12f73c8fb';

describe('the sealed bid record', () => {
  it('round trips a bid', () => {
    const bid = { auctionId: AUCTION, amountMinor: 125_00, name: 'ana' };
    expect(decodeBid(encodeBid(bid))).toEqual({ ...bid, contact: null, origin: null });
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
    // A full length name, so that 255 bytes of contact genuinely cannot fit
    // before the origin block. With a short name they now would.
    const name = 'n'.repeat(48);
    const bytes = encodeBid({ auctionId: AUCTION, amountMinor: 1, name });
    bytes[11 + AUCTION.length + name.length] = 255;
    expect(decodeBid(bytes)).toBeNull();
  });

  it('still reads a bid sealed before the format grew', () => {
    // Auctions are permanent links and one may be open right now, its bids
    // already sealed at 288 bytes with no origin block. Refusing them would
    // empty a live board at the moment it mattered.
    const v2 = new Uint8Array(288);
    const view = new DataView(v2.buffer);
    v2[0] = 2;
    view.setBigUint64(1, 125_00n, false);
    const id = new TextEncoder().encode(AUCTION);
    v2[9] = id.length;
    v2.set(id, 10);
    const name = new TextEncoder().encode('ana');
    v2[10 + id.length] = name.length;
    v2.set(name, 11 + id.length);
    v2[11 + id.length + name.length] = 0;

    expect(decodeBid(v2)).toEqual({
      auctionId: AUCTION, amountMinor: 125_00, name: 'ana', contact: null, origin: null,
    });

    // The old length is only accepted with the old version byte, and the new
    // length only with the new one. A record must not be readable two ways.
    const mislabelled = v2.slice();
    mislabelled[0] = 3;
    expect(decodeBid(mislabelled)).toBeNull();
    const short = encodeBid({ auctionId: AUCTION, amountMinor: 1, name: 'ana' }).slice(0, 288);
    expect(decodeBid(short)).toBeNull();
  });

  it('refuses a record whose origin block is not one this encoder would write', () => {
    const bytes = encodeBid({ auctionId: AUCTION, amountMinor: 1, name: 'ana' });
    // An amount with no currency: two encodings of the same bid otherwise.
    const orphan = bytes.slice();
    new DataView(orphan.buffer).setBigUint64(RECORD_BYTES - 9, 100n, false);
    expect(decodeBid(orphan)).toBeNull();

    // A currency code that is not three uppercase letters.
    const lower = encodeBid({
      auctionId: AUCTION, amountMinor: 1, name: 'ana',
      origin: { code: 'EUR', amountMinor: 100, decimals: 2 },
    });
    expect(decodeBid(lower)).not.toBeNull();
    lower[RECORD_BYTES - 12] = 'e'.charCodeAt(0);
    expect(decodeBid(lower)).toBeNull();

    // Decimals no currency has.
    const wild = encodeBid({
      auctionId: AUCTION, amountMinor: 1, name: 'ana',
      origin: { code: 'EUR', amountMinor: 100, decimals: 2 },
    });
    wild[RECORD_BYTES - 1] = 9;
    expect(decodeBid(wild)).toBeNull();
  });

  it('still refuses bytes hidden in the padding after a contact', () => {
    const bytes = encodeBid({ auctionId: AUCTION, amountMinor: 1, name: 'ana', contact: BLOB });
    bytes[RECORD_BYTES - 1] = 7;
    expect(decodeBid(bytes)).toBeNull();
  });
});
