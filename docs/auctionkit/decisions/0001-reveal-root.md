# 0001 — Committee-attested reveal root instead of onchain share verification

**Status:** accepted · **Date:** 2026-08-25

## Context

Peal's threshold decryption is publicly verifiable. `verify_share`
(`crates/bte-crypto/src/lib.rs:320`) checks
`e(pd_j, g_2) == sum_i e(ct_{i,0}, v_j^i)` — a real pairing check, run inline on
every submitted share.

That check is on BLS12-381.

**This decision originally rested on a false premise** — that BLS12-381 pairings
are not reachable from the EVM. EIP-2537 shipped on Ethereum mainnet with Pectra
on 2025-05-07. `spec/ROADMAP.md` item 5 predates that and is stale.

The decision still stands, but for narrower and honest reasons:

1. **The pairing is a multi-pairing that scales with batch size.**
   `sum_i e(ct_{i,0}, v_j^i)` is one term per ciphertext, so a B=64 batch is a
   ~65-term check per share, times `t` shares. EIP-2537 pairing gas is linear in
   term count. Nobody has benchmarked this, and designing around an unmeasured
   gas cost is how a product ships something that cannot be settled.
2. **Verifying shares is not decrypting.** Even with free pairings, the 64
   plaintexts come from the FFT cross-terms and FO decryption in `recover`.
   That is not going onchain at any gas price. The plaintext list still arrives
   off-chain and still needs binding to the commitments.
3. **L2 availability is unconfirmed.** OP-Stack support was in progress; whether
   the target chain has the precompile live must be checked against that chain,
   not assumed from L1.

## Decision

Use the adapter the specification describes: the committee snapshotted at
auction creation signs an EIP-712 message over a merkle root of the canonical
revealed-bid list, and the contract requires `threshold` unique signatures from
members of that snapshotted set.

Uniqueness is enforced by requiring the signature array to be ordered by
ascending recovered signer. A duplicate cannot appear in a strictly ascending
sequence, so one operator cannot sign twice to fake the threshold — checked in
O(n) with no nested loop and no scratch storage.

## Consequences

This is a **real weakening** and must be described as one. It adds a *t*-of-*n*
signing assumption on top of the *t*-of-*n* decryption assumption.

What survives, and why the design is still worth having:

- A malicious committee **cannot substitute a different plaintext** for a bid.
  Every revealed bid is re-checked against the salted commitment its bidder
  posted onchain *before* the close. Forging one means finding a preimage for a
  commitment that already exists. Tested:
  `test_committeeCannotSubstituteADifferentPlaintext`.
- A malicious committee **can omit bids** — but omission is caught by requiring
  `processedBidCount == committedBidCount` before `finalize()`, so an omitted bid
  halts the auction instead of silently moving the clearing price. Tested:
  `test_omittedBidBlocksSettlement`, `test_cannotFinalizeWithUnprocessedBids`.
- A halted auction hits the permissionless `failOnRevealTimeout()` path and
  everyone is refunded. Tested: `test_revealTimeoutRefundsEveryone`.

Censorship becomes a liveness failure with an objective recovery path. It never
becomes theft.

## When to revisit

**Soon, and with a benchmark rather than an argument.** The concrete next step is
to write a Solidity `verify_share` against the EIP-2537 precompiles and measure
the gas for a realistic batch size on the target chain.

If it fits, the committee signature layer can be replaced by onchain share
verification: a valid share *is* an attestation, so the separate signing key,
its rotation, and its equivocation risk all disappear. The commitment check per
bid stays either way — it is what binds plaintext to bidder.

If it does not fit at B=64, a smaller batch size for auctions may make it fit,
at the cost of more batches per auction. That is a tuning question, not an
architectural one.
