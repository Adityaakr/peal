# AuctionKit build log

## 2026-08-25 — slices 1–5, 9

**Toolchain.** Foundry was not installed despite `contracts/foundry.toml`
existing since phase 7; contracts had not been compiled locally in recent work.
Installed `forge 1.7.1`. Added `OpenZeppelin/openzeppelin-contracts@v5.1.0` —
only `forge-std` was vendored. Verified `Math.mulDiv` and `Math.Rounding`
against the vendored source rather than from memory.

Enabled `via_ir = true` in `foundry.toml`. Not optional: the 22-field snapshotted
`Config` struct exhausts the legacy codegen's stack in `initialize()`, and the
contracts do not compile without it.

**Slice 1–2: audit.** `repository-audit.md`, `trust-assumptions.md`,
`implementation-plan.md`. Three findings drove the design and are recorded as
decisions: no onchain share verification (0001), no domain separation in `seal()`
(0002), and multi-batch already working (`engine.rs:167`, no change needed).

**Slice 3: auction mathematics.** `ClearingPrice.sol` and `AuctionMath.sol` as
pure libraries — no storage, no tokens, no access control — so the clearing rule
could be fuzzed before anything held funds. 18 tests: the specification's
reference example, plus 7 fuzz properties.

Two bugs the tests caught in my own reasoning while writing them:

- An early sketch used a running "remaining supply" counter for pro-rata
  allocation. That makes the last claimer collect the leftovers — allocation
  becomes a race. Replaced with a formula over two totals fixed at finalization.
  Pinned by `test_proRataIsIndependentOfClaimOrder`.
- Undersubscribed auctions must clear at the **reserve**, not at the lowest tick
  anyone happened to bid, or one dust bid at the bottom sets the price for the
  whole sale. Pinned by `test_undersubscribedFillsAtReserve`.

**Slices 4, 5, 9: contract lifecycle, escrow, commitments, settlement,
recovery.** `SealedBidAuction.sol`, `CommitteeRegistry.sol`. 24 tests including
the reference example end-to-end with real ERC-20s, token conservation, the
reveal-timeout refund path, and the committee-integrity tests.

Test-harness issues fixed (my tests, not the contracts):
- `vm.expectRevert` does not observe inlined internal library calls; added an
  external harness for the guard tests.
- `vm.expectRevert` binds to the *next* external call, and `_signRoot` calls the
  auction to fetch the digest. Signatures must be built before the cheatcode.

**Results.** 65 contract tests pass (23 pre-existing unchanged, 42 new). Rust 14
suites and all TypeScript suites unchanged.

**Not yet built.** Slices 6–8 and 10–19: real Peal encryption wiring, the
committee node's independent close check, SDK, API, indexer, relayer, both UIs,
white-label config, receipts, E2E.

## 2026-09-08 — slice 6: the auction is sealed to the committee

An outside reader caught the contradiction: the landing page's own honest-limits
section admitted the live auction used salted commitments with the bidder holding
the salt, which is commit-reveal, the scheme the site argues against. Recorded as
[0005](./decisions/0005-wire-bte.md); the short version is that AuctionKit
stopped after the contract slices and slice 6 never happened.

**Built.** The auction now runs on batched threshold encryption (BTE), the
network's own primitive, with no contract change. The create page opens a coordinator condition at
the auction's end time and carries its id in `encryptionEpoch` (it fits: 29
ASCII bytes in a bytes32). The bid page seals a 232-byte payload, salt included,
in the browser through the SDK and commits the real ciphertext hash. A settler
(`packages/sealbid-settler`, modelled on the mempool one) joins opened slots to
committed bids by that hash, builds the reveal tree with one leaf per committed
bid, signs the digest with a threshold of committee keys, and drives
`registerRevealRoot` → `processReveals` → `finalize`, or `failOnRevealTimeout`
after the deadline. A bid that does not open to its commitment becomes a void
entry rather than a halt.

**Tests.** 19 new vitest cases in `peal-auctionkit` (condition, payload, merkle,
settle); the anvil e2e now settles through `planReveal`. 45 pass, 4 skip without
anvil. Explorer typechecks and builds.

**Copy.** The "not yet threshold encrypted" limit became a live item; a new build
item states what is still true, that the root is signed rather than verified
onchain. Home page fine print and the bid page's salt warnings rewritten.

**Not yet built.** Node-side signing (slice 8), onchain share verification (8b),
a multi-batch settlement check (7), and a new demo auction: the one at
`ACTIVE_DEMO.auction` predates the change and takes no bids.
