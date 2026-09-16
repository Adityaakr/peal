# Peal Links benchmarks

Measured on the build machine, not projected. Every number below has the command that produced it and the conditions. None of these are the paper's numbers; the paper's batched-verification throughput (about 1.05M verifications/s on an 18-core M5) is a different measurement on different hardware and is not repeated here as a Peal result.

Machine: Apple M5, 10 cores, 24 GiB, macOS 25.4, Rust 1.97 release profile (`lto = "thin"`), Node 22.23, Chromium 143 (Playwright 1.63). Circuit: R_op at Poseidon, depth 32/32, 51,791 SR1CS constraints, evaluation domain 2^16; R_dep about 400 R1CS.

## Proving

| what | where | result | conditions |
|---|---|---|---|
| R_op prove | native, 10 rayon threads | 521 ms median of 64 | `cargo run --release -p peal-bonsai --example bench_ledger` (evidence/phase-d/bench-ledger.md) |
| R_op prove | native, 1 thread | 1,780 ms | same run, single-thread rayon pool |
| R_op prove | wasm, Node 22 (V8), single thread | 6.4 to 6.7 s | `pnpm -C packages/links test` timings (evidence/phase-c/sdk-e2e-vitest.log) |
| R_op prove | wasm, Chromium Web Worker | about 5 to 7 s | inferred from the browser flow: three proofs plus two chain transactions and the rest of the flow in 38 s (evidence/phase-d/links-flow-playwright.log); not isolated |
| R_dep prove | wasm, Node | 0.32 s | SDK e2e timings |
| keygen R_op + R_dep | native, 10 threads | 684 ms | bench_ledger; the node does this once on first start |
| proving-key load in the browser | wasm | 0.7 s after download | 30 MB uncompressed key, digest-checked, cached in IndexedDB; before the change to uncompressed keys this was 15.6 s (300k point decompressions) and with point validation 47 s |

Not yet measured: proving on a phone; wasm with SIMD; a multi-threaded wasm build (blocked by cross-origin isolation, decision 0006).

## Verification and the ledger

| what | result | conditions |
|---|---|---|
| single verify including strict decode (canonical field elements, subgroup checks) | 937 us | mean of 50 on the verifier alone, 10 threads available |
| apply_batch of 1 | 1.7 ms | verify + four sqlite writes in one transaction, `synchronous=FULL` |
| apply_batch of 8 | 1.00 ms per op | batch verify (one pairing check for the batch) plus writes |
| apply_batch of 32 | 0.79 ms per op | same |
| full replay of 195 accepted ops, every proof re-verified | 239 ms | `Ledger::verify_replay` into an in-memory store |

Reading: past a batch of about 8 the sqlite writes dominate (about 0.7 ms per op of the 0.79), so the ledger actor's 25 ms window is a latency choice rather than a throughput one at this scale. Throughput on one core of this machine is on the order of 1,200 ops/s bounded by writes; the paper's verification figure is not the bottleneck here. Not yet measured: sustained throughput with many concurrent submitters, and the effect of a larger `batch_max`.

## End to end

| flow | wall clock | conditions |
|---|---|---|
| SDK e2e (two wallets: fund via dev mint, request, pay, deliver, claim, ack, backup, restore) | 27 s | `pnpm -C packages/links test`, Node wasm prover, live node, 4 proofs |
| SDK bridge (real deposit on anvil A with 2 confirmations, claim, pay, claim, withdraw with certificate, release on chain, cross-chain replay refused) | 52 s | `test/bridge.test.ts`, 5 proofs plus 6 chain transactions at 1 block/s |
| Browser flow (two contexts: create link, deposit from wallet, pay, claim, acknowledge, withdraw) | 56 s | `pnpm -C packages/explorer test:e2e e2e/links-flow.spec.ts`, 5 proofs in Web Workers |
| watcher credit latency | 2 to 3 s after inclusion | `confirmations: 2` at 1 block/s, 1.5 s poll interval |

## Not measured, stated plainly

- Latency distributions under a reproducible concurrent workload (the spec asks for cold and warm setup, batch size versus wait, network topology); the actor's window is fixed at 25 ms and was not tuned against load.
- Inbox delivery under load; archive path serving for receipts beyond the wallet's pruning horizon (no pruning is implemented in the wallet yet).
- Multi-node consensus latency (consensus not started).
