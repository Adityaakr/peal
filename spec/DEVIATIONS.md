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
