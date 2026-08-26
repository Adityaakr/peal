# 003 — SealBid as a product, and Vara.eth

_Prism run, 2026-08-27. Archetype PLAN, looped, one-way door, 6 lenses (4 returned, 2 stalled and were re-run by hand)._

## Recommendation

**Build the landing page, the use cases and the product-page improvements. Do not split the repo yet. Do not migrate to Vara.eth.**

If the Vara.eth work is a grant or ecosystem deliverable, say so and it becomes a
scoped **anchor-only program running alongside Hoodi**, deleting nothing. That is a
legitimate goal. It is not an argument about latency, and it should not be filed as one.

## Why

**The preconfirmation premise has no source.** `grep -rni "preconf"` across
gear-foundation/vara-eth-skills returns **zero matches**. The only latency mentions
are about *measuring* injected-transaction latency, not reducing it.

**Gear's own pattern contradicts the migration.** From `examples/escrow/README.md:11`:

> "In this escrow pattern, **funds stay in Solidity** until a Vara.eth callback confirms
> release, refund, or cancel."

Their recommended architecture for anything holding money keeps custody on L1 and moves
only state-machine logic. Migrating an auction that holds escrow is the thing the example
exists to warn against.

**Latency changes no outcome in this mechanism.** Clearing is a commutative fold
(`SealedBidAuction.sol:548`) evaluated once over a finished histogram (`:619-624`).
Allocation is order-independent by construction, and `ClearingPrice.sol:127-138` says so
in its own comment. The binding constants are `1 hour` bid window, `1 hour` reveal, and a
hardcoded `VOID_DISPUTE_WINDOW = 1 hours` (`SealedBidAuction.sol:223`). A 12s block is
0.3% of the smallest of those. The UI already polls on a 15s timer against 12s blocks
(`auction.ts:663`), so the app is slower than the chain it is on.

**The migration deletes decision 0003.** Accepted 2026-08-26: 6,490,317 gas per reveal at
B=64, measured on a Hoodi fork against a live EIP-2537 precompile. That is the only
benchmarked path to removing the committee trust assumption. It is a property of an EVM
with EIP-2537 and does not travel. Our own measurement puts B=64 on ethexe at 3.83e12 gas,
**3.83x a hard ceiling that funding cannot raise**. The unblock, gear-tech/gear #5582, is
still **Draft** with placeholder weights (verified 2026-08-27).

**The trust facts still hold, verified live today, not recalled.** Router
`0x9C13FE92…74cb6` owner is `0x19FDA330…D43d945` with `eth_getCode` = `0x`: a plain EOA,
no Safe, no timelock, controlling `setValidators()` and UUPS upgrade. `validatorsCount()`
= 4, `validatorsThreshold()` = 3. Putting escrow behind that, for a product sold on
trust-minimization, is a launch-blocker-class regression per the 2026-07-08 invariant.

**And the port is 55-75 engineer-days.** ~53% of 597 code lines port mechanically; the
other 47% is every path that holds money. The blocker is not gas or codecs, it is losing
transaction atomicity across `await`: `claim()` sets `b.claimed = true` before two
independent async transfers, with no rollback, so partial settlement becomes reachable
with no recovery path. Worse, `bidId = committedBidCount` would execute after an await,
reintroducing the exact race fixed in decision 0004 — and `BidIdRace.t.sol` becomes
inexpressible, because forge cannot model message interleaving.

## Steelman of migrating anyway

The strongest case, stated properly: Vara.eth's testnet settlement layer **is** Hoodi
(560048), the chain SealBid already uses, so "on Hoodi, via Vara.eth" is a true sentence
describing an addition. A Rust program links arkworks directly and needs no precompile at
all, so the pairing verifier that Solidity can only reach through EIP-2537 is, in
principle, native there. A Sails crate fits the existing cargo workspace and Rust-only CI
far more naturally than Solidity ever did. And there is an active Vara relationship in
this environment already.

Why we still pass: the pairing advantage is exactly the thing the measured gas ceiling
blocks, at 3.83x, and B=64 is baked into the ceremony CRS so B<=12 needs a new ceremony.
The workspace-fit argument is real but is an argument for a *future anchor program*, not
for moving a live auction that holds funds.

## Assumptions and falsifiers

- **Assumption:** no preconfirmation mechanism exists in Vara.eth today.
  **Falsifier:** a primary source describing one, with its trust model and whether a
  broken preconf is bonded. Nothing in Gear's own skills repo supports it.
- **Assumption:** #5582 has not merged. **Falsifier:** it merges with real weights, which
  softens the pairing objection considerably. The custody, atomicity and latency
  objections are untouched by it.
- **Assumption:** the auction's time windows stay hour-scale. **Falsifier:** a product
  requiring sub-minute auctions, which would make block time material for the first time.

## Open questions for you

1. **Is the Vara.eth work a grant or ecosystem deliverable?** This is the crux and only
   you can answer it. Your own memory records that a funded engagement flips the verdict
   from distraction to rational.
2. **Vara.eth, or Vara Network the Substrate L1?** They are different systems. Vara L1 has
   a BLS12-381 builtin actor; ethexe has zero builtins.
3. **Does the landing describe the live demo, or the shipped-contract capability?** They
   differ on reveal, which is the punchline of the strongest use case.

## What to do instead, in order

1. **Landing, use cases, product page.** Independent of the chain question. Doing now.
2. **Point `sealbid.peal.network` at the existing host** with a second Caddy host block
   routing to the landing. Brand acquired, ~4 lines, fully reversible. Split the repo when
   `peal-auctionkit` is published and there is a second consumer.
3. **Ship slice 6: real Peal sealing.** Until `auction.ts:358` stops faking the ciphertext
   hash, "SealBid" is a claim that cannot survive a demo call. `grep -rni bte
   packages/auctionkit/src/` returns nothing today.
4. **Write `AuctionFactory` and an issuer flow.** It is in the plan at
   `implementation-plan.md:75` and does not exist in code. Without it there is no product
   to name, on any domain, on any chain.
5. **EIP-2612 permit** if commit still feels slow. Deletes a block-wait and a wallet
   dialog. Roughly a day.

## Telemetry

```
- divergence: 0.57 (evidence 0.85, conclusion 0.15) | threshold 0.30 UNCALIBRATED
- grounding: n/a (no eval fixtures this run)
- models: draft=opus · skeptics=not run (4 lenses converged; 2 stalled and were verified by hand)
- claims: preconf-absent grounded · escrow-stays-in-solidity grounded · router-owner-EOA grounded
  · pr5582-draft grounded · latency-irrelevant grounded · seeded-bids-readable grounded
- fleet: 6 lenses (4 returned) · 2 re-run by orchestrator
```

> Cross-tier verification reduces instance- and tier-level error correlation but not
> shared-lineage blind spots. Treat cross-tier survival as weaker evidence than grounding.

All six load-bearing claims above are `grounded`: each was re-opened against live code, a
live chain, or a primary source during this run, not carried from memory.
