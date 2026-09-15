# 0001: Poseidon backend, depth 32 receipt log and nullifier tree

Date: 2026-09-16. Status: accepted.

## Decision
- Hash backend: **Poseidon** (`zkpari::circuits::hasher::HashKind::Poseidon`, width 3, alpha 5, 8 full and 57 partial rounds, as shipped upstream).
- Receipt-log depth **32** and nullifier SMT depth **32** (`crates/peal-bonsai/src/params.rs`).
- One circuit for every operation: the operation-hiding `OpCircuit` (R_op). `SendCircuit` and `RecvCircuit` are not used on the ledger.
- Circuit identity: `CIRCUIT_VERSION` plus backend, depths and both verifying keys' matrix digests, carried on every envelope and wallet.

## Why
- Upstream measures Poseidon receive at 30.7k R1CS versus 398k for Pedersen/Jubjub (paper Table 5). Browser proving is only plausible with Poseidon.
- Measured here: R_op at depth 32/32 is 51,791 Square R1CS constraints, evaluation domain 65,536. Depth 40/40 would land near the 2^16 boundary and risk a 2^17 domain, doubling prover time for no product benefit; 2^32 receipts is far beyond this deployment's horizon.
- R_op only: the paper's operation-hiding variant is what the spec asks for, and one circuit means one key, one verifier path and one record shape.

## Consequences
- The Poseidon parameters come from upstream's Grain LFSR call; upstream notes a deployment should run the reference `skip_matrices` security checks before fixing them. Recorded in MAINNET_READINESS.md.
- Changing any of these is a new `CIRCUIT_VERSION` and a new namespace; old proofs never verify under new keys.
