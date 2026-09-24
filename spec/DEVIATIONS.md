# Deviations log

Every divergence between the build spec and what was actually built, with the why.

## 1. DEM is the FO keystream, not HKDF-SHA256 + ChaCha20-Poly1305

The build spec's default KEM/DEM is HKDF-SHA256 into ChaCha20-Poly1305, "follow
simple-bte's own message handling if it provides one." It does: the `fo` module
(Fujisaki-Okamoto transform) encrypts byte strings directly — 16-byte random key K,
`ct1 = H_K([k*tau^(B+1)]_T) xor K`, `ct2 = H_M(K) xor msg` (SHA-256 counter-mode
keystream). We use it as-is. Integrity does not come from an AEAD tag but from the
FO re-derivation check (`k = H_R(K, msg)`, verify `[k]_1 == ct0`), which is the
scheme's own authenticity mechanism and is strictly per-ciphertext.

## 2. CCA via FO transform, not a separate 64-byte ZK proof

simple-bte's Schnorr PoK path exists only for G_T-element messages (`bte::encryption`).
The byte-string path (`fo`) intentionally drops it: "Unlike the base BTE there is no
Schnorr proof to check; the FO transform provides integrity at verification time
instead" (fo.rs:241). Wire ciphertexts therefore carry 64 bytes of overhead
(48B KEM header + 16B key mask), not 48+64+payload. Mauling any of ct0/ct1/ct2 makes
the re-derived `[k]_1` mismatch ct0 with overwhelming probability, and the slot is
flagged corrupt without affecting the rest of the batch. Gap vs a simulation-
extractable NIZK: rejection happens at reveal time, not at submission time — a
garbage ciphertext occupies a batch slot until the reveal marks it corrupt. Recorded
in SECURITY.md.

## 3. Header-only `partial` / `verify_share` mirror fo.rs call-for-call

`fo::partial_decrypt` and `fo::verify_partial_decryption` take `&[FoCiphertext]` but
read only `.ct0`. Operators only need the 48-byte headers, so our wrappers take
headers and issue the identical `G1::msm(ct0s, shares)` / `multi_pairing(ct0s, v_j)`
calls (see API-MAP.md). This is API adaptation, not scheme reimplementation.

## 4. Monorepo clone skipped

Thresholdization is built into `simple-bte::crs::setup`; the fallback plan (Shamir via
commonware-cryptography bls12381) was unnecessary, so commonwarexyz/monorepo was not
cloned.

## 5. `partial()` does not verify ciphertext proofs before signing

In the base (non-FO) path, `partial_decrypt` verifies the batch Schnorr proofs first.
The FO path has no proofs to check, matching fo.rs behavior. Operators sign whatever
frozen header set the coordinator publishes; correctness of the reveal is still
publicly checkable share-by-share and slot-by-slot.

## 6. revealRoot transaction is sent by the key-holder script, not the Rust coordinator

BteAnchor.revealRoot is restricted to a coordinator ADDRESS, per spec. The Rust
coordinator binary stays chain-free (its only RPC use is read-only
eth_blockNumber polling); the reveal root is published by whichever process
holds ANCHOR_PRIVATE_KEY — in the anchored demo, the demo script itself, via
bte-sdk's anchorRevealRoot. Keeps heavyweight signing deps out of the
coordinator; the onchain trust boundary (one authorized address) is unchanged.

## v1: deliberate deviations from "DKG Is All You Need"

Scheme v1 (`crates/bte-crypto/src/tbte/`, spec/index.md section 3b) follows
the paper's Figure 1. Where it departs, on purpose:

### v1.1 Message m = 0; the pad is a KEM secret

The paper encrypts a group-element message with the pad `k^2 [sk]_T` (its
`ct4`). We send `m = 0`, never transmit `ct4`, and use the pad itself as the
KEM secret: the DEM key is `HKDF-SHA256(secret, ct1 || ct2 || ct3)` into
ChaCha20-Poly1305 with a zero nonce (one key per ciphertext). Byte payloads
of any length up to the cap ride in the AEAD body; a failed tag marks that
slot only.

### v1.2 A context commitment in the statement

The proof's statement and the AEAD associated data carry a caller-supplied
context hash (`context_hash`, tagged SHA-256 of the context bytes). Peal's
coordinator uses `peal-condition:<condition id>`, so a ciphertext verifies
under exactly one condition and cannot be copied into another one. The
paper's statement has no such field; adding an unconstrained public variable
to a sigma protocol does not change the relation, it only binds the proof.

### v1.3 The parameter digest in the challenge, not just pk

The Fiat-Shamir challenge is
`H(params_digest || context_hash || ct1 || ct2 || ct3 || body_hash || A1 || A2 || A3)`.
The paper binds `pk`; we bind the committee's parameter digest, which covers
`pk`, every `pk_j`, and the DKG output (`setup_digest`). A reshared
committee with the same `pk` is therefore a different statement, and a
ciphertext verifies under one committee only.

### v1.4 One coordinator decoy per batch

Freeze adds exactly one coordinator-sealed decoy to every v1 condition. It
is not a cryptographic requirement of the paper: it keeps `sum_i k_i != 0`
against a sealer's own `(k, -k)` pair (which `check_batch` rejects
otherwise) and lets an empty condition reveal. v0's fixed-B padding does not
apply; v1 has no batch bound, only the `MAX_BATCH_SLOTS` = 4096 cap and one
batch per condition (4095 real ciphertexts plus the decoy).

### v1.5 Naive cross terms by default

The paper's Section 4 evaluates the cross terms `U_i`, `W_i` in
O(B log^2 B) group operations through a subproduct tree. That path is
implemented (`tbte/poly.rs`, `CrossTermStrategy::Fast`) and `tests/tbte.rs`
proves it equal to the naive path at every size tried. Measured with
`examples/tbte_crossover.rs` (release, one thread), arkworks' group FFTs
lose to `B` Pippenger MSMs of size `B` by 3.5x to 7x for every batch up to
1024, so `CrossTermStrategy::Auto` takes the naive path below
`FAST_PATH_MIN_BATCH` (32768, extrapolated, not measured at that size).
The naive path's memory is O(B) per row, and the batch cap bounds its work.

### v1.6 The N3f1 threshold rule

The paper takes an arbitrary t-of-n. Our threshold is fixed by the DKG's
fault model, Commonware's `N3f1` (`f = floor((n-1)/3)`, quorum `n - f`):
the shared polynomial has degree `quorum - 1`, so `t = n - f` (three of
four, four of five, five of seven). A 3-of-5 committee is not offered for
v1 because the weaker model loses secrecy under asynchrony.
