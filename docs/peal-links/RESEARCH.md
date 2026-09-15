# Peal Links research notes

Retrieved 2026-09-16. Detailed source reports with citations: `research/bonsai-sources.md` (paper and blog) and `research/commonware-library.md` (Commonware crates). This file is the integrator's summary: what exists, what Peal adds, and where each cryptographic operation lives.

## Sources and revisions

| Source | Where | Revision / date | License |
|---|---|---|---|
| Bonsai paper, "Bonsai: Scalable Private Payments" (O'Grady, Meier, Policharla) | https://eprint.iacr.org/2026/1987 | received 2026-09-12, single version | CC BY |
| Blog "Out of Sight, Out of State" | https://commonware.xyz/blogs/private-payments | ~2026-09-12 | site terms |
| ZK-Pari prototype with payment circuits | https://github.com/guruvamsi-policharla/zk-pari PR #2 | head `a8266aac58314214552a214fead1c0258f8de418` (2026-09, still open; main is `3db79adc`, no circuits) | `Cargo.toml` says `MIT/Apache-2.0`; no LICENSE file in the tree |
| Commonware Library | https://github.com/commonwarexyz/monorepo | crates at `2026.9.0` (tag `v2026.9.0` = `d476a236`), Rust >= 1.95, edition 2024 | MIT OR Apache-2.0 |
| arkworks (`ark-*`) | crates.io | 0.6.0 | MIT OR Apache-2.0 |

The Commonware monorepo contains no Bonsai or ZK-Pari code. The prototype is the external PR above; it is a research artifact, not a release, and its author is one of the paper's authors.

## Toolchain and build

- Rust 1.97 stable (the prototype pins `stable`). `cargo test --release --features circuits` at the pinned revision: 31 passed, 0 failed, 1 ignored (`evidence/phase-a-upstream-zkpari-tests.log`).
- Peal pins it as a git dependency in the workspace `Cargo.toml` with `default-features = false, features = ["std", "circuits"]`; native builds add `parallel`.

## What Bonsai does

Account-based private payments. The validator holds, per account, one 32-byte commitment `com = Com_acct(b, root_null; r)` to the balance and the root of the account's private sparse Merkle tree of claimed receipt positions. It also holds the receipt log (a Merkle Mountain Range in the paper) and a window of its W most recent roots. It stores no nullifiers.

- **Send**: publishes `rho = Com_rec(v, Sen, Rec; r'')` into the receipt log and moves `com` to `com'` with `b' = b - v`, proven by R_send.
- **Receive**: proves a receipt at position `pid` under a revealed recent root, that `pid` was not in the claimed tree, and moves to `com'` with `b' = b + v` and the tree root updated by the insertion of `pid`. The nullifier is the position itself, never published.
- **Operation hiding (R_op)**: every operation publishes the same record shape `(A, com', rho, root_rho, pi)` and appends one receipt; a receive appends an unspendable type-0 dummy. Observers see the acting account and nothing else.
- **Pruning**: the wallet keeps a frontier of its claimed-position tree and moves old nullifiers to cold storage; validator state does not grow with claims.

## What exists as code (pinned revision)

| Operation | Upstream file | Functions / types | Upstream tests |
|---|---|---|---|
| Collision-resistant hash (Pedersen or Poseidon), `Com_acct`, `Com_rec`, Merkle node | `src/circuits/hasher.rs` | `HashCfg`, `hash`, `hash_var`, `DOM_ACCT`, `DOM_REC`, `DOM_NODE` | `circuits::tests::hash_native_matches_circuit` |
| Receipt tree (fixed depth, stand-in for the MMR) | `src/circuits/merkle.rs` | `MerkleTree`, `MerklePath`, `compute_root_with_bits`, `alloc_siblings` | via recv tests |
| Claimed-position SMT with in-circuit insertion | `src/circuits/smt.rs` | `SparseMerkleTree`, `SmtInsertion`, `enforce_smt_insert` | `smt_insertion_witness_is_consistent`, `smt_rejects_duplicate_position` |
| R_send | `src/circuits/send.rs` | `SendCircuit` | `send_satisfiable_and_statement_binding`, `send_overdraft_unsatisfiable`, `send_allows_zero_amount` |
| R_recv | `src/circuits/recv.rs` | `RecvCircuit` | `recv_*` (satisfiable, wrong position, double receive, overflow, high bits pinned) |
| R_op (operation hiding) | `src/circuits/op.rs` | `OpCircuit` (`is_send`, `public_input = [A, com, com', rho, root]`) | `op_send_*`, `op_receive_*`, `op_branches_are_shape_identical`, `op_dummy_receipt_unspendable` |
| Key generation (trusted setup, per circuit) | `src/generator.rs` | `ZkPari::keygen`, `keygen_with_trapdoor` | `test::key_serialization_roundtrip`, `hashidx_separates_same_shape_circuits` |
| Proving | `src/prover.rs` | `ZkPari::prove` (returns `Unsatisfiable` on a bad witness) | `test::roundtrip_*`, `proofs_are_randomized` |
| Verification (3 pairings) | `src/verifier.rs` | `ZkPari::verify` | `test::proof_serialization_roundtrip_and_malformed_inputs` |
| Batch verification (random 128-bit linear combination) | `src/batch_verify.rs` | `ZkPari::batch_verify` | `test::batch_verify` |
| Proof and key encodings | `src/data_structures.rs` | `Proof` (2 G1 + 1 F, 128 bytes), `ProvingKey`, `VerifyingKey`, `SuccinctIndex.matrix_digest` | serialization tests |
| HVZK simulator (needs the trapdoor; test and benchmark only) | `src/simulator.rs` | `ZkPari::simulate` | `simulate_accepts_*` |
| Benchmarks | `benches/{prover,circuits,batch_verify,throughput}.rs` | published results in `benches/results/` | |

## What Peal must implement (and where it now lives)

| Missing piece | Peal implementation |
|---|---|
| Persistent receipt log with historical paths and a recent-root window | `crates/peal-bonsai/src/trees.rs::ReceiptTree`, `ledger.rs::Ledger::recent_roots` |
| Persistent, serializable claimed-position tree for wallets | `trees.rs::ClaimedSet` (parity-tested against upstream `SparseMerkleTree`) |
| Account identity, registration, namespace binding, signed envelopes | `account.rs` (decisions 0002, 0003) |
| Wallet state, witness construction, two-phase journal, crash reconcile | `wallet.rs` |
| Ledger state transition function, durable store, replay, batch isolation | `ledger.rs` (feature `ledger`) |
| Strict wire decoding (canonical field elements, subgroup checks) | `encoding.rs` |
| Deposits (R_dep relation, intents, dedup by event identity) | `deposit.rs` (decision 0004); EVM gateway and watcher in Phase D |
| Withdrawals (burn identifier, consumed openings, committee certificates, gateway contract) | Phase D (decision 0005) |
| Key management (generation, digests, circuit id, distribution) | `params.rs` |
| Receipt delivery (encrypted inbox), recipient encryption keys, backups, recovery | Phase C (SDK + wasm) |
| Browser proving (single-threaded wasm, Web Worker) | Phase C (decision 0006) |
| Consensus and multi-node ordering | Phase C (Commonware `simplex`, `2026.9.0`) |
| Product API, request manifests, checkout, dashboard | Phases B, E |

## Security assumptions and open obligations

- **Knowledge soundness** of ZK-Pari is proven in the algebraic group model under a q-DLOG assumption (paper Theorem 4); **zero knowledge** is statistical HVZK (Theorem 5).
- **Remark 2 (verbatim from the paper):** "Theorems 4 and 5 establish knowledge soundness and zero knowledge but the payment protocol of Section 6 additionally relies on simulation extractability (Definition 4). We expect that ZK-PARI is simulation extractable, but we defer a formal proof to future work." No later work resolving this was found on the research date. The payment protocol's security therefore rests on an unproved property. This stays in MAINNET_READINESS.md until a proof exists.
- **Trusted setup**: per circuit, trapdoor `(alpha, beta, delta, tau)`. The prototype's `keygen` samples and discards it in one process. Production needs a ceremony; none exists.
- **Poseidon parameters**: generated by the reference Grain LFSR; upstream says a deployment should run the reference matrix-security checks. Not done.
- **Ledger honesty**: the paper assumes an honest ledger party for privacy; liveness and ordering are consensus questions Bonsai leaves open. Peal's single-node ledger is a development mode.
- **Metadata**: submission metadata (RPC sessions, IP, timing) links operations to users; the paper argues this is already true of RPC-submitted transactions. Peal does not claim metadata privacy.
- **Upstream simplifications inherited**: identifiers are plain field elements with no well-formedness check (`Rec in N_lambda` is not enforced); the receipt tree is fixed-depth rather than an MMR; the Pedersen instantiation's generators come from a fixed seed (Peal uses Poseidon).

## Changes Peal introduces to the construction

1. Namespace-bound identifiers (decision 0002). No circuit change.
2. Registration by revealing `r_A` (decision 0003). No circuit change.
3. R_dep, a new small relation for deposits (decision 0004). New circuit, separate key, same setup caveats.
4. Withdrawal by send to a burn identifier plus a disclosed opening (decision 0005). No circuit change; a new native check and a committee-attested bridge.
5. Old commitment carried on the envelope as a staleness hint (checked, not trusted).

## Benchmark scope

- Published numbers (paper, M5 MacBook Pro 18 threads): 128-byte proofs; single verify ~0.72 ms; 2^16-batch ~11.7 us amortized; ~1.05M verifications/s sharded. These exclude parsing and subgroup checks and are not Peal measurements.
- Measured here (Phase A, Apple M5 10 cores, release, multi-threaded): keygen ~0.66 s, R_op prove 0.5 to 0.8 s, R_op = 51,791 SR1CS constraints at depth 32/32. Not yet measured: single-threaded and wasm proving, verification under load, end-to-end latency, watcher lag, delivery, claim, withdrawal. Those go in BENCHMARKS.md as they are measured.
