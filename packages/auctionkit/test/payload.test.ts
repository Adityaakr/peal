import { describe, expect, it } from 'vitest';
import { BID_PAYLOAD_BYTES, decodeBidPayload, encodeBidPayload, type BidPayload } from '../src/payload.js';
import { bidCommitment } from '../src/commitment.js';

const P: BidPayload = {
  chainId: 42431,
  auction: '0xCA90E426b2dF09C800CDb39b9F0BE00492E551B9',
  bidder: '0x1111111111111111111111111111111111111111',
  quantity: 120_000n * 10n ** 18n,
  maxPriceTick: 18,
  salt: `0x${'ab'.repeat(32)}`,
  bidVersion: 1,
};

describe('bid payload', () => {
  it('is fixed width behind a magic prefix', () => {
    const bytes = encodeBidPayload(P);
    expect(bytes.length).toBe(BID_PAYLOAD_BYTES);
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('PEALBID1');
  });

  it('round-trips every field, and the commitment computed from it matches', () => {
    const back = decodeBidPayload(encodeBidPayload(P));
    expect(back).not.toBeNull();
    expect(back!.chainId).toBe(P.chainId);
    expect(back!.auction.toLowerCase()).toBe(P.auction.toLowerCase());
    expect(back!.bidder.toLowerCase()).toBe(P.bidder.toLowerCase());
    expect(back!.quantity).toBe(P.quantity);
    expect(back!.maxPriceTick).toBe(P.maxPriceTick);
    expect(back!.salt).toBe(P.salt);
    expect(back!.bidVersion).toBe(P.bidVersion);
    expect(bidCommitment(back!)).toBe(bidCommitment(P));
  });

  it('rejects what is not a bid without throwing', () => {
    expect(decodeBidPayload(new Uint8Array(0))).toBeNull();
    expect(decodeBidPayload(new TextEncoder().encode('sealed bid: 42'))).toBeNull();
    const wrongMagic = encodeBidPayload(P);
    wrongMagic[7] = 0x32; // PEALBID2
    expect(decodeBidPayload(wrongMagic)).toBeNull();
    const truncated = encodeBidPayload(P).subarray(0, BID_PAYLOAD_BYTES - 1);
    expect(decodeBidPayload(truncated)).toBeNull();
    // Right length, junk body: uint16 fields carry non-zero high bytes.
    const junk = new Uint8Array(BID_PAYLOAD_BYTES).fill(0xff);
    junk.set(encodeBidPayload(P).subarray(0, 8));
    expect(decodeBidPayload(junk)).toBeNull();
  });

  it('refuses to encode out-of-range fields', () => {
    expect(() => encodeBidPayload({ ...P, maxPriceTick: 70_000 })).toThrow(RangeError);
    expect(() => encodeBidPayload({ ...P, salt: '0xdead' as never })).toThrow(RangeError);
  });
});
