# 0009: Recent-root window of 1024, judged at application time

Date: 2026-09-16. Status: accepted.

## Decision
- The ledger accepts a receive that reveals any of the last **1024** receipt roots (`root_window`, node config default; the paper's W).
- The window is a ring of roots updated on every append and checked inside `apply_verified`, the write path shared by single application, batched application and replay. Batch verification still pre-filters cheaply, but the authoritative check happens when the operation is written.

## Why
- A browser proof takes about seven seconds; on a busy ledger dozens of appends can land in between, and a rejected proof costs the payer another seven seconds. 1024 roots is minutes of headroom at the measured local throughput and costs 32 KB of memory.
- The Phase D benchmark found that checking the window once per batch let a late operation in a large batch be accepted although a replay (which applies one at a time) would reject it. Determinism of the state transition function does not depend on batching only if the check sees the same state in both paths.

## Consequences
- A test (`batch_application_respects_the_root_window_and_replays_identically`) pins the behaviour at the window edge and replays.
- Roots older than the window require the wallet to fetch a fresh path (the receipt tree serves paths against the current root at any time).
