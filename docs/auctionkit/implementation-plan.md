# Peal AuctionKit — implementation plan

Derived from `repository-audit.md`. Ordered by dependency, not by visibility.

## Architecture decisions forced by the audit

Three findings decide the shape of everything else:

1. **Shares are not verifiable on the EVM** → the contract cannot check
   threshold decryption. Use the committee-attested reveal root: *t* EIP-712
   signatures from the *snapshotted* committee over a merkle root of the
   canonical revealed-bid list. Recorded in `decisions/0001-reveal-root.md`.

2. **No domain separation in `seal()`** → context (protocol, version, chainId,
   auction contract, auctionId, batchIndex, bidId, epoch) travels *inside* the
   plaintext and is verified after decryption. Recorded in
   `decisions/0002-domain-separation.md`.

3. **Multi-batch already works** (`engine.rs:167`) → no batching changes needed;
   an auction maps to one condition, which becomes ⌈bids/64⌉ batches.

## Slices

Each slice ends with tests passing before the next begins.

| # | slice | state |
|---|---|---|
| 1 | Repository audit + trust assumptions | **done** |
| 2 | Mechanism + security boundaries (this doc, decisions/) | **done** |
| 3 | **Auction mathematics, standalone and tested** | **done** |
| 4 | Contract lifecycle, escrow, custody | **done** |
| 5 | Bid commitments | **done** |
| 6 | Real Peal encryption integration | pending |
| 7 | Multi-batch support | pending |
| 8 | Committee-controlled reveal | **contract side done**, node side pending |
| 9 | Settlement + recovery | **done** |
| 10 | SDK + API | pending |
| 11 | Indexer + relayer | pending |
| 12 | Bidder interface | pending |
| 13 | Issuer interface | pending |
| 14 | White-label configuration | pending |
| 15 | Receipts + verification | pending |
| 16 | E2E | pending |
| 17 | Security tooling | pending |
| 18 | Operational docs | pending |
| 19 | Clean-room demonstration | pending |

Slice 3 is deliberately first among the code: the clearing-price algorithm is
the part of this product that is *hard to get right and easy to get wrong
silently*. It is implemented as a pure Solidity library with no storage, no
tokens and no access control, so it can be fuzzed and property-tested in
isolation before anything touches funds.

## Price representation

Prices are **quote-token base units per whole sale token**:

```
price(tick) = reservePrice + tick * tickSize        [quote base units / 1e{saleDecimals} sale base units]
cost        = mulDiv(quantity, price, 10**saleDecimals)
```

Escrow rounds **up** (`Rounding.Ceil`) so a bidder's deposit always covers their
maximum possible payment. Settlement charges round **down** (`Rounding.Floor`)
so the protocol never over-charges. The gap is refundable dust in the bidder's
favour, never against them.

Ticks are bounded (`MAX_TICKS = 256`) so settlement cannot be made unbounded by
attacker-chosen prices. `tick` is `uint16` on the wire but validated `< numTicks`.

## Contracts

```
AuctionFactory        deploys versioned SealedBidAuction clones, snapshots fee config
SealedBidAuction      lifecycle, escrow, custody, reveal processing, settlement, claims
CommitteeRegistry     committee sets; snapshotted by id into each auction
ClearingPrice (lib)   pure uniform-price algorithm — slice 3
AuctionMath (lib)     decimal-safe cost/escrow via OZ Math.mulDiv
RevealRoot (lib)      EIP-712 digest + threshold signature verification
```

Non-upgradeable clones with immutable/snapshotted config. No admin sweep.

## What is explicitly out of scope for this milestone

Encrypted order flow, swaps, bridging, prediction markets, bonding curves. The
Private Actions work already in the repository is untouched.
