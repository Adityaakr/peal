# 0015: Transparent batched threshold encryption from a DKG (BTE v1)

Date: 2026-09-25. Status: accepted.

## What was asked

Check whether Peal implements "DKG Is All You Need" (Policharla, Commonware, 2026) and, since it does not, implement it end to end: a new crypto backend, a real DKG for the committee, coordinator and operator wiring, the browser seal path, wire format, tests, benches, docs, and the encrypted mempool on top.

## What was checked

- `crates/bte-crypto` wraps `simple-bte` at rev `147a0878`, which is "Simple BTE" (eprint 2026/760), the paper's Table 1 prior work: MPC/trusted-dealer setup, public parameters of size O(Bn), a batch bound B fixed at ceremony time, punctured powers of tau. `crs::setup` samples tau in-process (`bte-cli ceremony`). SECURITY.md: "There is no DKG, no resharing."
- The paper's scheme: setup is a DKG of one random scalar `sk`; `pk = [sk]_1`, `pk_j = [sk_j]_1`; ciphertext `([k]_1, [k]_2, k(g' + x pk))` with `x = H([k]_1)` plus a sigma-protocol NIZK; partial decryption `sk_j · sum_i ct1_i`; verification `e(pd_j, [1]_2) = e(pk_j, sum_i ct2_i)`; decryption by pairings with cross terms, computable in O(B log^2 B) group operations through the Cauchy transform (Lemma 1, eq. 2). Assumption DBSDH. Extracted text: session scratch; PDF at `~/Downloads/dkg-is-all-you-need.pdf`.
- `commonware-cryptography 2026.9.0` (already pinned by `peal-links-consensus`) ships `bls12381::dkg::feldman_desmedt`: Joint-Feldman DKG with signed dealer logs, `Info::new`, `Dealer::start`, `Player::dealer_message`, `Dealer::finalize`, `SignedDealerLog::check`, `Logs`, `Player::finalize`, `observe`. Shares are `Scalar` (blst, 32-byte big-endian on the wire), public polynomial `Sharing<MinPk>` with `partial_public(Participant)` in G1 (zcash compressed, 48 bytes). Mode `NonZeroCounter` evaluates participant `i` (0-based) at `i + 1`. Fault model `N3f1`: `f = ⌊(n − 1)/3⌋`, quorum `n − f`, and the shared polynomial has degree `quorum − 1` (`Info::degree`), so the scheme's threshold is `t = n − f`: n = 5 gives f = 1 and t = 4. (The module doc's "degree 2f" holds only when n = 3f + 1; the code was read and the conversion test pinned t = 4.)
- arkworks 0.6 (already a dependency): `MapToCurveBasedHasher<G1Projective, DefaultFieldHasher<Sha256>, WBMap<g1::Config>>` for hash-to-curve; `Radix2EvaluationDomain::fft` accepts projective group elements (`DomainCoeff` blanket impl); `deserialize_compressed` performs curve and subgroup checks.

## Decision

1. **Scheme v1 lives beside v0.** New module `bte_crypto::tbte` ("transparent BTE") with its own types, wire tag `BTE1`, and a `scheme` field on committees. v0 keeps running for existing committees and its golden files; new committees default to v1. Nothing in v0 is weakened or removed.
2. **The DKG is Commonware's Feldman-Desmedt**, not a hand-rolled one. Operators hold ed25519 identities; dealers = players = the operator set; fault model `N3f1`, which makes a five-operator committee 4-of-5 (a weaker honest-majority model would give 3-of-5 but loses secrecy under asynchrony, so it is not offered); namespace `PEAL-BTE-V1-DKG` + committee tag; round counter persisted per tag. The DKG output's public polynomial is converted to arkworks (`pk`, `pk_j`), the share to `Fr`. A test proves the conversion: `[share_j]_1` equals the DKG's `partial_public(j)` and Lagrange interpolation of any three converted shares gives a scalar whose G1 image is `pk`.
3. **Transport is the coordinator as an untrusted bulletin board.** Dealer public messages and signed logs are posted in the clear; private dealings are sealed to the recipient's X25519 key with ChaCha20-Poly1305 and authenticated by the dealer's ed25519 signature. The coordinator learns no share, cannot forge a dealer, and can only stall (which is visible). Operators finalize locally; the coordinator observes the same logs and publishes the committee.
4. **Payloads use a KEM/DEM.** The paper's pad `k^2 [sk]_T` is the KEM secret (message `m = 0`, so `ct4` is never sent); the DEM is ChaCha20-Poly1305 under `HKDF-SHA256(secret, ct1 || ct2 || ct3)`. The sigma-protocol Fiat-Shamir challenge covers the committee's parameter digest (pk, every operator key, the DKG output), a caller context (Peal: `peal-condition:<condition id>`), `ct1`, `ct2`, `ct3` and the hash of the DEM body, so the proof binds the whole ciphertext to one committee and one condition (closing the v0 hole "nothing binds a ciphertext to a committee"; added after the review pass found the first draft bound only `pk`). Wire: ciphertext overhead 313 bytes, header 325, share 55.
5. **Operators verify every ciphertext proof and the distinct-`x` rule before signing** (Fig. 1 PartialDec). Headers carry `ct1, ct2, ct3, body_hash, proof`; bodies never reach operators.
6. **No fixed batch size.** Freeze takes every ciphertext under the condition. Decoy padding stays as a privacy policy (batch size hiding), not a cryptographic requirement.
7. **Decryption uses the paper's fast aggregation** (subproduct tree, derivative, remainder tree, batch inversion). A naive O(B^2) MSM path remains as the test oracle and the small-batch fallback.
8. **Not touched:** the live Tempo contracts, the Railway deployment, real funds. The mempool contracts only consume ciphertext hashes and merkle roots, so the demo switches committee without a contract change.

## Steelman of the rejected options

- *Keep v0 and only add a DKG for tau powers:* the secret is structured (tau, tau^2, ..., tau^B), which no stock DKG produces; the batch bound and O(Bn) parameters remain. Rejected: it is the wrong shape of hard and does not remove the bound.
- *Hand-roll a Pedersen DKG in arkworks:* fewer conversions. Rejected: an audited implementation with signed logs, reveals, and resharing exists in the pinned Commonware release; CLAUDE.md prefers existing frameworks.
- *Run the DKG over commonware-p2p between nodes:* cleanest transport. Rejected for v1: operator nodes are outbound-only by design; a relay through the coordinator keeps that property, and the DKG's own signatures and encryption make the relay untrusted.

## Assumptions and falsifiers

- Fiat-Shamir sigma protocols give the simulation-extractability the paper's CCA proof needs (the paper says so; standard in the ROM). Falsifier: a published break of FS-sigma SE for this relation.
- `N3f1` with n = 5 yields t = 4 (not 3, as first assumed from the module doc). Established by the conversion test; the copy says "4 of 5" for v1 committees.
- Group FFT in ark-poly 0.6 is correct for projective points. Falsifier: the fast-vs-naive equivalence test.

## Open questions

- Resharing (operator rotation) is supported by the same Commonware module; wired later.
- Straight-line extractability (paper §2) is not proven for the plain sigma protocol; recorded in SECURITY.md as the residual gap.

## Record of the build (2026-09-25)

Commits on `feat/peal-links`: `504aec3` (scheme core), `34f197f` (review fixes, DKG wrapper), `f63908d` (coordinator scheme layer), `f1f2f0b` (relay, node, CLI, stack script), then wasm/SDK/docs. Review pass on the core: one skeptic (Opus) confirmed the algebra, the sigma protocol and the validation, and found the O(B²) memory, the missing batch cap, the missing context binding, the Σk = 0 stall, and the panic paths; all fixed before anything was wired on top. Measured: `examples/tbte_crossover.rs` (naive vs fast cross terms), `scripts/bte/v1-stack.sh demo` (five processes, DKG settled in about a second, reveal of four slots in 35 ms of crypto).
