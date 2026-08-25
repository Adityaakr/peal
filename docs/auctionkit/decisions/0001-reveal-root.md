# 0001 — Committee-attested reveal root instead of onchain share verification

**Status:** accepted · **Date:** 2026-08-25

## Context

Peal's threshold decryption is publicly verifiable. `verify_share`
(`crates/bte-crypto/src/lib.rs:320`) checks
`e(pd_j, g_2) == sum_i e(ct_{i,0}, v_j^i)` — a real pairing check, run inline on
every submitted share.

That check is on BLS12-381. **It is not reachable from the EVM today.** EIP-2537
precompiles are roadmap item 5 in `spec/ROADMAP.md` and nothing in `contracts/`
attempts a pairing. `BteAnchor.sol` anchors a merkle root; it verifies no
cryptography.

So the auction contract cannot verify that the plaintexts it is being handed
came from a legitimate threshold decryption.

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

When EIP-2537 ships on the target chain, the pairing check becomes feasible
onchain and this adapter can be replaced with direct verification of the
decryption itself, removing the signing assumption entirely.
