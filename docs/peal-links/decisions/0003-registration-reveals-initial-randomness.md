# 0003: Registration opens the initial commitment by revealing r_A

Date: 2026-09-16. Status: accepted.

## Decision
`RegisterEnvelope` carries `r_A`; the ledger computes `com0 = Com_acct(0, root_empty; r_A)` itself and stores that. It never accepts an opaque initial commitment.

## Why
The paper's R_reg proves knowledge of the signing key and opens `Com_acct(Init[A], root_empty; r_A)`. With `Init[A] = 0` and `root_empty` public, "opening" is exactly "revealing `r_A`", so no SNARK is needed. Accepting an opaque `com0` would let anyone register a hidden non-zero balance.

## Consequences
- Nothing about the account is public after the first operation: R_op replaces `r_A` with fresh randomness inside the new commitment.
- An observer knows a fresh account's first operation is a receive or a zero-value send, which is inherent to starting at zero.
