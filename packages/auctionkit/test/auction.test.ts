import { describe, expect, it } from 'vitest';
import { BidValidationError, prepareBid, priceLadder, type AuctionConfig } from '../src/auction.js';
import { bidCommitment } from '../src/commitment.js';
import { DEPLOYMENTS, deploymentFor, HOODI } from '../src/addresses.js';
import { escrowFor } from '../src/clearing.js';

const ONE = 10n ** 18n;

const cfg: AuctionConfig = {
  issuer: '0x1111111111111111111111111111111111111111',
  saleToken: '0x2222222222222222222222222222222222222222',
  quoteToken: '0x3333333333333333333333333333333333333333',
  totalSupply: 1_000_000n * ONE,
  saleDecimals: 18,
  quoteDecimals: 18,
  reservePrice: ONE,
  tickSize: ONE / 10n,
  numTicks: 32,
  startTime: 0n,
  endTime: 10_000n,
  revealDeadline: 20_000n,
  minBidQuantity: ONE,
  maxQuantityPerAddress: 200_000n * ONE,
  maxBids: 256,
  allowlistRoot: `0x${'0'.repeat(64)}`,
  protocolFeeBps: 100,
  feeRecipient: '0x1111111111111111111111111111111111111111',
  committeeSetId: `0x${'a'.repeat(64)}`,
  encryptionEpoch: `0x${'b'.repeat(64)}`,
  metadataHash: `0x${'c'.repeat(64)}`,
  version: 1,
};

const auction = '0x4444444444444444444444444444444444444444' as const;
const bidder = '0x5555555555555555555555555555555555555555' as const;
const base = { cfg, chainId: 560048, auction, bidder } as const;

describe('prepareBid', () => {
  it('produces a commitment that matches an independent computation', () => {
    const bid = prepareBid({ ...base, quantity: 10n * ONE, maxPriceTick: 3 });
    expect(bid.commitment).toBe(
      bidCommitment({
        chainId: 560048,
        auction,
        bidder,
        quantity: 10n * ONE,
        maxPriceTick: 3,
        salt: bid.salt,
        bidVersion: 1,
      }),
    );
  });

  it('escrows quantity at the bidder’s own maximum price', () => {
    const bid = prepareBid({ ...base, quantity: 10n * ONE, maxPriceTick: 3 });
    expect(bid.escrow).toBe(escrowFor(10n * ONE, cfg.reservePrice, cfg.tickSize, 3, 18));
    // 10 tokens at 1.30 = 13
    expect(bid.escrow).toBe(13n * ONE);
  });

  it('gives every bid a distinct salt by default', () => {
    const a = prepareBid({ ...base, quantity: ONE, maxPriceTick: 0 });
    const b = prepareBid({ ...base, quantity: ONE, maxPriceTick: 0 });
    expect(a.salt).not.toBe(b.salt);
    // Same parameters, different salt — so the commitment differs too, which is
    // what stops an observer confirming a guessed bid.
    expect(a.commitment).not.toBe(b.commitment);
  });

  it('rejects a bid the contract would void, before any gas is spent', () => {
    expect(() => prepareBid({ ...base, quantity: ONE, maxPriceTick: 32 })).toThrow(BidValidationError);
    expect(() => prepareBid({ ...base, quantity: ONE, maxPriceTick: -1 })).toThrow(BidValidationError);
    expect(() => prepareBid({ ...base, quantity: ONE / 2n, maxPriceTick: 0 })).toThrow(BidValidationError);
    expect(() => prepareBid({ ...base, quantity: 500_000n * ONE, maxPriceTick: 0 })).toThrow(
      BidValidationError,
    );
  });

  it('allows an unlimited per-address cap when it is zero', () => {
    const open = { ...cfg, maxQuantityPerAddress: 0n };
    expect(() => prepareBid({ ...base, cfg: open, quantity: 999_999n * ONE, maxPriceTick: 0 })).not.toThrow();
  });
});

describe('priceLadder', () => {
  it('runs from the reserve upward, one entry per tick', () => {
    const ladder = priceLadder(cfg);
    expect(ladder).toHaveLength(32);
    expect(ladder[0]).toEqual({ tick: 0, price: ONE });
    expect(ladder[31]).toEqual({ tick: 31, price: ONE + 31n * (ONE / 10n) });
  });
});

describe('deploymentFor', () => {
  it('refuses a stale deployment rather than letting funds reach it', () => {
    expect(HOODI.current).toBe(false);
    expect(() => deploymentFor(560048)).toThrow(/out of date/);
  });

  it('names the chains it does know when asked for one it does not', () => {
    expect(() => deploymentFor(1)).toThrow(/Ethereum Hoodi \(560048\)/);
  });

  it('still exposes stale entries for tooling that needs the address', () => {
    expect(DEPLOYMENTS[560048]?.auctionImplementation).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
