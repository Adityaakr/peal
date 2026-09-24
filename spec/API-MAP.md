# API map: simple-bte -> bte-crypto wrapper

Source: `github.com/commonwarexyz/simple-bte` pinned at rev `147a08788f6c9b25b52dc58f03518ac30e94d5b8`
(crate name `simple-batched-threshold-encryption`, ark 0.6, curve BLS12-381).
Every group operation in bte goes through this crate. We do not reimplement pairing
math, group FFTs, or the scheme.

## Key finding: the `fo` module is the message-handling path

simple-bte ships two encryption paths:

1. `bte::encryption` — G_T messages, Schnorr PoK of k (`SchnorrProof`, 48+32 bytes).
   Messages must be group elements; unusable for byte payloads without a hand-rolled KEM.
2. `bte::fo` — Fujisaki-Okamoto transform over byte-string messages
   (`fo.rs:1` "Encrypts byte-string messages"). This IS the scheme's own message
   handling, so per section D of the build spec we use it. FO gives CCA-style
   integrity in the ROM via deterministic re-derivable randomness `k = H_R(K, msg)`.

`FoCiphertext<E>` (`fo.rs:180`):
- `ct0: E::G1Affine` — `[k]_1`, the 48-byte KEM header (compressed BLS12-381 G1)
- `ct1: [u8; 16]`  — `H_K(k*ek) xor K`, encrypted symmetric key
- `ct2: Vec<u8>`   — `H_M(K) xor msg`, encrypted payload

Overhead vs plaintext: 48 + 16 = 64 bytes. No separate proof field; integrity is
checked at decryption time by re-deriving `k` and comparing `[k]_1 == ct0`.

## Function map

| bte-crypto (ours) | simple-bte source | notes |
|---|---|---|
| `ceremony(n, t, b, rng)` | `bte::crs::setup(batch_size, num_parties, threshold, rng)` (`crs.rs:12`) | Thresholdization is BUILT IN: Shamir-shares each `tau^i` (i=1..B) with a fresh degree-(t-1) polynomial, publishes `v_j^i = [sigma_j^i]_2`. Returns `(EncryptionKey, DecryptionKey, Vec<SecretKey>)`. tau is a local variable dropped inside `setup`; the dealer is the process that calls it. We serialize the affine material into `PublicParams` + per-operator `OperatorSecret` and drop the rest. |
| `seal(params, payload, rng)` | `bte::fo::encrypt(ek, msg, rng)` (`fo.rs:217`) | Payload cap 5 MiB enforced by the wrapper before calling. |
| `partial(secret, headers)` | mirrors `bte::fo::partial_decrypt` (`fo.rs:242`): `value = G1::msm(ct0s, sk.shares)` | Source takes `&[FoCiphertext]` but reads only `.ct0`; our wrapper takes 48-byte headers and performs the identical MSM call. One share = one G1 element = 48 bytes compressed, independent of B. |
| `verify_share(params, headers, share)` | mirrors `bte::fo::verify_partial_decryption` (`fo.rs:262`): `e(pd_j, g_2) == multi_pairing(ct0s, v_j)` | Same header-only adaptation; identical pairing calls. |
| Lagrange combine (inside `recover`) | `bte::decryption::combine` (`decryption.rs:83`), re-exported by `fo` | Interpolation at x=0 with batch inversion. |
| `pre_decrypt(params, batch)` | `bte::fo::predecrypt_fft(dk, cts)` (`fo.rs:289`) | FFT cross-terms; O(B log B) group ops + 2B pairings; needs NO shares. `DecryptionKey.fft_h` / `fft_domain` are precomputed in setup; we rebuild them deterministically from `powers_of_h_affine` when deserializing params. |
| `finalize(pre, pd, batch)` | `bte::fo::helper_finalize_bandwidth_optimized(dk, pd, cts, cross)` (`fo.rs:373`) | Returns `(messages, randomness k_i)`. We then run a per-slot validity check `[k_i]_1 == ct0_i` (public API: one G1 mul per slot) — a slot that fails is marked corrupt WITHOUT poisoning the batch (FFT recovery is per-slot linear). |
| `recover(params, batch, shares)` | `combine` + `predecrypt_fft` + `helper_finalize_bandwidth_optimized` | Implemented exactly as `pre_decrypt` + combine + `finalize`. Errors explicitly with fewer than t verified shares. |

## What we deliberately do NOT use

- `bte::encryption::encrypt` / `SchnorrProof` / `verify_ciphertext_batch` — the G_T-message
  CPA+PoK path. FO supersedes it for byte payloads.
- `helper_decrypt` / `batch_verify` (full hints with `pairing_values`) — the verifier-optimized
  hint path; `batch_verify` is all-or-nothing over the batch, which would let one mauled
  ciphertext poison the reveal. The bandwidth-optimized path gives per-slot checkability.
- `msm_small`, `h_k`/`h_r`/`h_m_xor` — private helpers; never touched directly.

## Thresholdization support

Present in `crs::setup` — no need for commonware-cryptography's bls12381 Shamir module;
the monorepo clone is unnecessary. Party indices are 1-based (`SecretKey.party_index`,
`crs.rs:57` evaluates shares at x = j for j in 1..=N).

## CCA support

The FO transform is the CCA mechanism (implicit-rejection style: decryptor re-derives
`k` from the recovered key+message and checks `[k]_1 == ct0`). There is no separate
64-byte proof on the wire in the FO path. See DEVIATIONS.md #2.

## Serialization

simple-bte types have no serde; all carry arkworks `CanonicalSerialize` (compressed:
G1 48B, G2 96B, G_T 576B, scalar 32B). Our wire types are length-framed canonical
bytes with a `BTE_WIRE_V0` tag; runtime-only material (prepared pairings, FFT tables)
is rebuilt on deserialize.

## Scheme v1: paper Figure 1 -> `crates/bte-crypto/src/tbte/`

Source: "DKG Is All You Need" (Policharla, Commonware, 2026), Figure 1, and
Section 4 for the cross terms. Group operations are arkworks 0.6 over
BLS12-381; nothing from simple-bte is used on this path.

| paper (Fig. 1) | bte-crypto (`tbte::`) | notes |
|---|---|---|
| Setup: `sk` shared, `pk = [sk]_1`, `pk_j = [sk_j]_1`, `g'` | `dkg::OperatorRound` (`start`, `public_message`, `private_messages`, `receive_dealing`, `receive_ack`, `finalize_dealer`, `finalize`), `dkg::observe`, `PublicParams::assemble`, `g_prime()` | Output converted from Commonware types: `pk`, `pk_j` as `G1Affine`, the share as `Fr`. `g'` is hash-to-curve with the `PEAL-BTE-V1` tag. |
| Enc: `k`, `x = H([k]_1)`, `([k]_1, [k]_2, k(g' + x pk))`, NIZK, pad `k^2 [sk]_T` | `seal(params, context, payload, rng)` with `x_of`, `nizk::prove` | `m = 0`; pad -> HKDF-SHA256 -> ChaCha20-Poly1305 body (DEVIATIONS v1.1). Proof in `nizk.rs`. |
| Verify a ciphertext's proof | `verify_ciphertext(params, header)` | Points not the identity, proof verifies against this committee and context. Run by the coordinator at intake. |
| PartialDec admission: proofs verify, `x_i` distinct | `check_batch(params, batch)` | Also rejects an empty batch, more than `MAX_BATCH_SLOTS`, and `sum_i ct1_i = 0`. Returns the `x_i`. |
| PartialDec: `pd_j = sk_j sum_i ct1_i` | `partial(params, secret, batch)` | Calls `check_batch` first. One G1 point per batch, 55 bytes framed. |
| Verify: `e(pd_j, [1]_2) = e(pk_j, sum_i ct2_i)` | `verify_share(params, batch, share)`; `verify_share_admitted` skips the re-admission | Never panics. |
| Combine: Lagrange at zero over `t` shares | `combine(params, shares)` -> `CombinedShare` | Errors with fewer than `t` shares. |
| Cross terms `U_i`, `W_i` (Section 4) | `pre_decrypt(params, batch)` / `pre_decrypt_with(params, batch, strategy)`; `cross_terms_naive`, `poly::cross_terms_fast` | Depend only on ciphertexts, so they run before any share (pipelining). Default strategy `Auto` (DEVIATIONS v1.5). |
| Dec: `S_i = e(pd - W_i, ct2_i) e(ct3_i, U_i)`, open slot `i` | `slot_secret`, `finalize(params, pre, combined, batch)` | Per slot; a failed AEAD tag marks that slot only. Refuses cross terms computed for a different batch. |
| Full recovery | `recover(params, batch, shares)` | `pre_decrypt` + `verify_share_admitted` filter + `combine` + `finalize`. |

Wire (`tbte::wire`, magic `BTE1`): `Ciphertext`, `CtHeader`, `Share`,
`PublicParams`, `OperatorSecret`; `pack_headers` / `unpack_headers`;
`is_v1(bytes)` dispatches between schemes.

## DKG: `tbte::dkg` -> `commonware_cryptography::bls12381::dkg::feldman_desmedt`

`commonware-cryptography` 2026.9.0 (already pinned by `peal-links-consensus`).
Variant `MinPk`, fault model `commonware_utils::N3f1`, mode
`NonZeroCounter` (participant `i`, 0-based, evaluated at `i + 1`), identities
`commonware_cryptography::ed25519`.

| bte-crypto (`tbte::dkg`) | commonware | notes |
|---|---|---|
| `RoundConfig::info()` | `Info::new::<N3f1>(namespace, round, None, Mode::NonZeroCounter, Reveal::V1, dealers, players)` | Namespace `PEAL-BTE-V1-DKG` + NUL + committee tag; dealers = players = the sorted operator identity set. |
| `OperatorRound::start` | `Dealer::start::<N3f1>(rng, info, me, None)`, `Player::new(info, me)` | Every operator is a dealer and a player. The dealer seed is kept so a restarted process regenerates the same dealing. |
| `public_message` / `private_messages` | `DealerPubMsg`, `DealerPrivMsg` (commonware-codec encoded) | Public message goes in a signed `Envelope` in the clear; each private message additionally inside a `SealedBox` (X25519 + ChaCha20-Poly1305) to the recipient. |
| `receive_dealing` | `Player::dealer_message::<N3f1>(dealer, pub_msg, priv_msg)` -> `PlayerAck` | The acknowledgement is returned to the dealer through the relay. |
| `receive_ack` | `Dealer::receive_player_ack(player, ack)` | |
| `finalize_dealer` | `Dealer::finalize::<N3f1>()` -> `SignedDealerLog` | Acks, or reveals for players that did not acknowledge in time. |
| `collect_logs` (private) | `SignedDealerLog::check(info)`, `Logs::new`, `Logs::record` | A log with a bad signature is rejected. |
| `OperatorRound::finalize` | `Player::finalize::<N3f1, _>(rng, logs, &Sequential)` -> `(Output, share)` | Then `params_from_output` and `share_to_secret`; asserts `[share_j]_1 == pk_j`. |
| `observe` | `feldman_desmedt::observe::<MinPk, _, N3f1, _>(rng, logs, &Sequential)` -> `Output` | Anyone with the signed logs derives the same parameters; the coordinator uses this to publish the committee. |
| `params_from_encoded_output` | `Output` decode, `Sharing::partial_public(Participant)` | Re-derives `PublicParams` from a stored DKG output. |

Transport (the coordinator as an untrusted bulletin board): `Envelope`
(`Kind`, signed by the sender's ed25519 identity, `sign` / `verify`),
`BoxSecret`, `seal_box` / `open_box`, `box_aad`. Relay routes:
`/v0/dkg/rounds`, `/v0/dkg/rounds/{id}/envelopes`, `/v0/dkg/pending`.
