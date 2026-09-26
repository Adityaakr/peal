//! BTE v1: batched threshold encryption with a transparent setup.
//!
//! Implements "DKG Is All You Need" (Policharla, Commonware, 2026), Figure 1,
//! over BLS12-381 with arkworks. The committee's whole secret is one scalar
//! `sk`, Shamir-shared by a distributed key generation; nothing here depends
//! on a batch bound, and the public parameters are `n + 1` G1 points.
//!
//! Scheme (additive notation, `[a]_b = a * generator_b`, `∘` the pairing):
//!
//! - Setup: `g'` is a G1 point with unknown discrete log (hash-to-curve),
//!   `pk = [sk]_1`, `pk_j = [sk_j]_1` for every operator `j`.
//! - Seal: `k ← F`, `x = H([k]_1)`, `ct = ([k]_1, [k]_2, k·(g' + x·pk))`,
//!   KEM secret `S = k²·[sk]_T`, a sigma-protocol proof of `k` binding
//!   `pk`, the three points and the DEM body (the paper's `ct4` slot; we
//!   send `m = 0`, so the pad itself is the key).
//! - Partial decryption: every proof verified and the `x_i` pairwise
//!   distinct, then `pd_j = sk_j · Σ_i ct1_i`. One G1 point per batch.
//! - Verification: `pd_j ∘ [1]_2 = pk_j ∘ Σ_i ct2_i`.
//! - Combine: Lagrange interpolation at zero over `t` verified shares.
//! - Decrypt: `S_i = (pd − W_i) ∘ ct2_i + ct3_i ∘ U_i` with the cross terms
//!   `U_i = Σ_{j≠i} ct2_j / (x_j − x_i)`, `W_i = Σ_{j≠i} ct3_j / (x_j − x_i)`
//!   (naive, the test oracle) or the Cauchy-transform evaluation of
//!   Section 4 (`poly.rs`, quasi-linear).
//!
//! Binding: the proof's challenge and the DEM's associated data cover the
//! committee's parameter digest (which includes the DKG output, so a
//! resharing with the same `pk` is a different committee) and a caller
//! supplied context (the application's condition, chain, namespace), so a
//! ciphertext verifies under exactly one committee and one context. Every
//! derived value carries a `PEAL-BTE-V1-*` tag; content addresses
//! (`Ciphertext::hash`, body hashes) are plain SHA-256 over wire bytes.

pub mod nizk;
pub mod wire;

#[cfg(feature = "dev-dealer")]
pub mod dev;

#[cfg(feature = "dkg")]
pub mod dkg;

use crate::BteError;
use ark_bls12_381::{Bls12_381, Fr, G1Affine, G1Projective, G2Affine, G2Projective};
use ark_ec::hashing::{
    curve_maps::wb::WBMap, map_to_curve_hasher::MapToCurveBasedHasher, HashToCurve,
};
use ark_ec::pairing::{Pairing, PairingOutput};
use ark_ec::{AffineRepr, CurveGroup, PrimeGroup};
use ark_ff::field_hashers::{DefaultFieldHasher, HashToField};
#[cfg(feature = "full")]
use ark_ff::Field;
use ark_ff::Zero;
use ark_serialize::CanonicalSerialize;
use ark_std::rand::{CryptoRng, Rng};
use ark_std::UniformRand;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

pub use nizk::Proof;

pub type E = Bls12_381;

/// Version tag prefixed to every v1 wire type.
pub const BTE_WIRE_V1: &[u8; 4] = b"BTE1";

/// Hash-to-curve tag for `g'`, the second G1 generator with unknown log.
const DST_GPRIME: &[u8] = b"PEAL-BTE-V1-GPRIME";
/// Hash-to-field tag for `x = H([k]_1)`.
const DST_X: &[u8] = b"PEAL-BTE-V1-X";
/// HKDF salt for the KEM secret.
const KEM_SALT: &[u8] = b"PEAL-BTE-V1-KEM";
/// Committee setup provenance tag used by the DKG output digest.
pub const SETUP_DOMAIN: &[u8] = b"PEAL-BTE-V1-SETUP";

/// The AEAD tag appended to every DEM body.
pub const DEM_TAG_BYTES: usize = 16;
/// Hash tag for the caller's context bytes.
const DST_CONTEXT: &[u8] = b"PEAL-BTE-V1-CONTEXT";
/// Hard cap on the slots one batch may hold; the naive cross-term path is
/// `B` MSMs of size `B`, so this bounds the decryptor's work and memory.
pub const MAX_BATCH_SLOTS: usize = 4096;

/// Public parameters of one v1 committee.
#[derive(Clone, Debug)]
pub struct PublicParams {
    n: u16,
    t: u16,
    /// `pk = [sk]_1`.
    pk: G1Affine,
    /// `operator_keys[j - 1] = [sk_j]_1`, party indices are 1-based.
    operator_keys: Vec<G1Affine>,
    /// Provenance of the key: the DKG output digest (or the dev dealer's tag).
    setup_digest: [u8; 32],
    digest: [u8; 32],
}

impl PublicParams {
    pub fn assemble(
        n: u16,
        t: u16,
        pk: G1Affine,
        operator_keys: Vec<G1Affine>,
        setup_digest: [u8; 32],
    ) -> Result<Self, BteError> {
        if n == 0 || t == 0 || t > n {
            return Err(BteError::InvalidParams("need 1 <= t <= n".into()));
        }
        if operator_keys.len() != n as usize {
            return Err(BteError::InvalidParams(format!(
                "expected {n} operator keys, got {}",
                operator_keys.len()
            )));
        }
        if pk.is_zero() || operator_keys.iter().any(|k| k.is_zero()) {
            return Err(BteError::InvalidParams("identity public key".into()));
        }
        let mut p = PublicParams {
            n,
            t,
            pk,
            operator_keys,
            setup_digest,
            digest: [0u8; 32],
        };
        p.digest = Sha256::digest(p.to_bytes()).into();
        Ok(p)
    }

    /// Stable digest: sha256 over the canonical wire bytes.
    pub fn digest(&self) -> [u8; 32] {
        self.digest
    }

    pub fn n(&self) -> u16 {
        self.n
    }

    pub fn t(&self) -> u16 {
        self.t
    }

    /// `pk = [sk]_1`.
    pub fn pk(&self) -> G1Affine {
        self.pk
    }

    /// `[sk_j]_1` for every operator, index `j - 1`.
    pub fn operator_keys(&self) -> &[G1Affine] {
        &self.operator_keys
    }

    /// Provenance of the key: the DKG output digest (or the dev dealer's tag).
    pub fn setup_digest(&self) -> [u8; 32] {
        self.setup_digest
    }
}

/// One operator's share of `sk`. Deliberately no Debug.
#[derive(Clone)]
pub struct OperatorSecret {
    /// 1-based party index.
    pub party_index: u16,
    pub(crate) share: Fr,
}

impl OperatorSecret {
    pub fn new(party_index: u16, share: Fr) -> Self {
        OperatorSecret { party_index, share }
    }

    /// `[sk_j]_1`, to compare with the committee's operator key.
    pub fn public_key(&self) -> G1Affine {
        (G1Projective::generator() * self.share).into_affine()
    }
}

impl Drop for OperatorSecret {
    fn drop(&mut self) {
        // A volatile write the optimizer cannot elide.
        // SAFETY: `share` is a valid, exclusively borrowed field.
        unsafe { core::ptr::write_volatile(&mut self.share, Fr::zero()) };
    }
}

/// A sealed payload: the three KEM points, the context it was sealed for,
/// the proof of `k`, and the DEM body (ChaCha20-Poly1305 ciphertext plus tag).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ciphertext {
    pub ct1: G1Affine,
    pub ct2: G2Affine,
    pub ct3: G1Affine,
    /// `H(context)`: what the sealer bound this ciphertext to (a condition,
    /// a chain, an application). The relay enforces it matches the slot.
    pub context_hash: [u8; 32],
    pub proof: Proof,
    pub body: Vec<u8>,
}

impl Ciphertext {
    /// Content address: sha256 over the wire bytes.
    pub fn hash(&self) -> [u8; 32] {
        Sha256::digest(self.to_bytes()).into()
    }

    /// The compressed KEM point `[k]_1`: unique per honest ciphertext, so a
    /// relay can refuse a second ciphertext with the same randomness.
    pub fn kem_point_bytes(&self) -> [u8; 48] {
        compressed(&self.ct1)
            .try_into()
            .expect("compressed G1 is 48 bytes")
    }

    /// Everything an operator needs: the points, the proof, and the body hash
    /// the proof was bound to. Bodies never reach operators.
    pub fn header(&self) -> CtHeader {
        CtHeader {
            ct1: self.ct1,
            ct2: self.ct2,
            ct3: self.ct3,
            context_hash: self.context_hash,
            body_hash: Sha256::digest(&self.body).into(),
            proof: self.proof,
        }
    }
}

/// The public part of a ciphertext (325 bytes on the wire, framed).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CtHeader {
    pub ct1: G1Affine,
    pub ct2: G2Affine,
    pub ct3: G1Affine,
    pub context_hash: [u8; 32],
    pub body_hash: [u8; 32],
    pub proof: Proof,
}

/// The context Peal's coordinator expects for a ciphertext sealed to a
/// condition: the SDK, the wasm seal and the coordinator all use this.
pub fn condition_context(condition_id: &str) -> Vec<u8> {
    format!("peal-condition:{condition_id}").into_bytes()
}

/// The tagged hash of a caller's context bytes.
pub fn context_hash(context: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DST_CONTEXT);
    h.update((context.len() as u64).to_le_bytes());
    h.update(context);
    h.finalize().into()
}

/// One operator's partial decryption for a whole batch: one G1 point.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Share {
    /// 1-based party index.
    pub party_index: u16,
    pub value: G1Affine,
}

/// `g'`: a G1 generator nobody knows the discrete log of.
pub fn g_prime() -> G1Affine {
    static G: OnceLock<G1Affine> = OnceLock::new();
    *G.get_or_init(|| {
        let hasher = MapToCurveBasedHasher::<
            G1Projective,
            DefaultFieldHasher<Sha256, 128>,
            WBMap<ark_bls12_381::g1::Config>,
        >::new(DST_GPRIME)
        .expect("BLS12-381 G1 hash-to-curve parameters are valid");
        hasher
            .hash(b"peal batched threshold encryption v1")
            .expect("hash-to-curve cannot fail")
    })
}

fn compressed<T: CanonicalSerialize>(p: &T) -> Vec<u8> {
    let mut out = Vec::with_capacity(p.compressed_size());
    p.serialize_compressed(&mut out)
        .expect("canonical serialization cannot fail on a Vec");
    out
}

/// `x = H([k]_1)`, a collision-resistant map from the KEM point to the field.
pub fn x_of(ct1: &G1Affine) -> Fr {
    let hasher = <DefaultFieldHasher<Sha256, 128> as HashToField<Fr>>::new(DST_X);
    hasher.hash_to_field::<1>(&compressed(ct1))[0]
}

/// `g' + x·pk`, the base of the third ciphertext point.
fn ct3_base(params: &PublicParams, x: Fr) -> G1Projective {
    g_prime().into_group() + params.pk.into_group() * x
}

/// Symmetric key from the KEM secret, bound to the three points.
fn dem_key(secret: &PairingOutput<E>, ct1: &G1Affine, ct2: &G2Affine, ct3: &G1Affine) -> [u8; 32] {
    let mut info = Vec::with_capacity(48 + 96 + 48);
    info.extend_from_slice(&compressed(ct1));
    info.extend_from_slice(&compressed(ct2));
    info.extend_from_slice(&compressed(ct3));
    let hk = Hkdf::<Sha256>::new(Some(KEM_SALT), &compressed(secret));
    let mut key = [0u8; 32];
    hk.expand(&info, &mut key)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    key
}

/// AAD binds the DEM body to the committee, the context and the KEM points.
fn dem_aad(
    params: &PublicParams,
    context_hash: &[u8; 32],
    ct1: &G1Affine,
    ct2: &G2Affine,
    ct3: &G1Affine,
) -> Vec<u8> {
    let mut aad = Vec::with_capacity(64 + 48 * 2 + 96);
    aad.extend_from_slice(&params.digest());
    aad.extend_from_slice(context_hash);
    aad.extend_from_slice(&compressed(ct1));
    aad.extend_from_slice(&compressed(ct2));
    aad.extend_from_slice(&compressed(ct3));
    aad
}

/// Seal a payload under the committee's key for one context (the condition
/// or application the ciphertext belongs to; the relay checks it). Takes no
/// batch number and no position; the batch is whatever is frozen at the cue.
pub fn seal(
    params: &PublicParams,
    context: &[u8],
    payload: &[u8],
    rng: &mut (impl Rng + CryptoRng),
) -> Result<Ciphertext, BteError> {
    if payload.len() > crate::MAX_PAYLOAD_BYTES {
        return Err(BteError::PayloadTooLarge);
    }
    let context_hash = context_hash(context);
    let mut k = Fr::rand(rng);
    while k.is_zero() {
        k = Fr::rand(rng);
    }
    let ct1 = (G1Projective::generator() * k).into_affine();
    let ct2 = (G2Projective::generator() * k).into_affine();
    let x = x_of(&ct1);
    let ct3 = (ct3_base(params, x) * k).into_affine();
    // S = k² · [sk]_T = e(k·pk, [k]_2).
    let secret = E::pairing(params.pk.into_group() * k, ct2);
    let key = dem_key(&secret, &ct1, &ct2, &ct3);
    let aad = dem_aad(params, &context_hash, &ct1, &ct2, &ct3);
    let cipher = ChaCha20Poly1305::new((&key).into());
    // The key is unique per ciphertext (fresh k), so a fixed nonce is sound.
    let body = cipher
        .encrypt(
            &Nonce::default(),
            Payload {
                msg: payload,
                aad: &aad,
            },
        )
        .map_err(|_| BteError::InvalidParams("DEM encryption failed".into()))?;
    let body_hash: [u8; 32] = Sha256::digest(&body).into();
    let statement = nizk::Statement {
        ct1: &ct1,
        ct2: &ct2,
        ct3: &ct3,
        context_hash: &context_hash,
        body_hash: &body_hash,
    };
    let proof = nizk::prove(params, k, &statement, rng);
    Ok(Ciphertext {
        ct1,
        ct2,
        ct3,
        context_hash,
        proof,
        body,
    })
}

/// Sort a batch into freeze order: ascending ct_hash.
pub fn sort_by_ct_hash(cts: &mut [Ciphertext]) {
    cts.sort_by_cached_key(|ct| ct.hash());
}

/// A ciphertext is well formed if its points are not the identity and its
/// proof verifies against this committee.
pub fn verify_ciphertext(params: &PublicParams, header: &CtHeader) -> bool {
    if header.ct1.is_zero() || header.ct2.is_zero() || header.ct3.is_zero() {
        return false;
    }
    nizk::verify(params, header)
}

#[cfg(feature = "full")]
pub use full::*;

#[cfg(feature = "full")]
mod full {
    use super::*;
    use ark_ec::VariableBaseMSM;
    use ark_ff::batch_inversion;
    use std::collections::HashSet;

    /// Fig. 1's admission rule for a batch: every proof verifies and the
    /// points `x_i` are pairwise distinct. Returns the `x_i`.
    pub fn check_batch(params: &PublicParams, batch: &[CtHeader]) -> Result<Vec<Fr>, BteError> {
        if batch.is_empty() {
            return Err(BteError::InvalidParams("empty batch".into()));
        }
        if batch.len() > MAX_BATCH_SLOTS {
            return Err(BteError::BatchSize {
                expected: MAX_BATCH_SLOTS,
                got: batch.len(),
            });
        }
        let mut seen = HashSet::with_capacity(batch.len());
        let mut xs = Vec::with_capacity(batch.len());
        for (i, h) in batch.iter().enumerate() {
            if !verify_ciphertext(params, h) {
                return Err(BteError::InvalidCiphertext(format!(
                    "slot {i}: proof rejected"
                )));
            }
            let x = x_of(&h.ct1);
            if !seen.insert(compressed(&x)) {
                return Err(BteError::InvalidCiphertext(format!(
                    "slot {i}: duplicate point"
                )));
            }
            xs.push(x);
        }
        // Σ k_i = 0 would make every honest partial the identity, which
        // `verify_share` rejects; only a sealer's own (k, −k) pair does this.
        if sum_ct1(batch).is_zero() {
            return Err(BteError::InvalidCiphertext(
                "batch randomness sums to zero".into(),
            ));
        }
        Ok(xs)
    }

    fn sum_ct1(batch: &[CtHeader]) -> G1Projective {
        batch.iter().map(|h| h.ct1.into_group()).sum()
    }

    fn sum_ct2(batch: &[CtHeader]) -> G2Projective {
        batch.iter().map(|h| h.ct2.into_group()).sum()
    }

    /// `pd_j = sk_j · Σ_i ct1_i`, after admitting the batch.
    pub fn partial(
        params: &PublicParams,
        secret: &OperatorSecret,
        batch: &[CtHeader],
    ) -> Result<Share, BteError> {
        check_batch(params, batch)?;
        let value = (sum_ct1(batch) * secret.share).into_affine();
        Ok(Share {
            party_index: secret.party_index,
            value,
        })
    }

    /// Public verifiability: `pd_j ∘ [1]_2 == pk_j ∘ Σ_i ct2_i`. Never panics.
    pub fn verify_share(params: &PublicParams, batch: &[CtHeader], share: &Share) -> bool {
        if check_batch(params, batch).is_err() {
            return false;
        }
        verify_share_admitted(params, batch, share)
    }

    /// The pairing check alone, for a batch already admitted by `check_batch`.
    pub fn verify_share_admitted(params: &PublicParams, batch: &[CtHeader], share: &Share) -> bool {
        let party = share.party_index as usize;
        if party == 0 || party > params.n as usize || share.value.is_zero() {
            return false;
        }
        let pk_j = params.operator_keys[party - 1];
        let lhs = E::pairing(share.value, G2Affine::generator());
        let rhs = E::pairing(pk_j, sum_ct2(batch));
        lhs == rhs
    }

    /// `pd = sk · Σ_i ct1_i`, interpolated from `t` shares.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct CombinedShare(pub(crate) G1Projective);

    /// Lagrange interpolation at zero over party indices. Duplicates are
    /// dropped; fewer than `t` distinct shares is an explicit error.
    pub fn combine(params: &PublicParams, shares: &[Share]) -> Result<CombinedShare, BteError> {
        let mut seen = HashSet::new();
        let chosen: Vec<&Share> = shares
            .iter()
            .filter(|s| {
                s.party_index != 0 && s.party_index <= params.n && seen.insert(s.party_index)
            })
            .take(params.t as usize)
            .collect();
        if chosen.len() < params.t as usize {
            return Err(BteError::NotEnoughShares {
                need: params.t as usize,
                have: chosen.len(),
            });
        }
        let xs: Vec<Fr> = chosen
            .iter()
            .map(|s| Fr::from(s.party_index as u64))
            .collect();
        let mut denominators: Vec<Fr> = xs
            .iter()
            .map(|xj| {
                xs.iter()
                    .filter(|xm| *xm != xj)
                    .map(|xm| *xm - xj)
                    .product()
            })
            .collect();
        batch_inversion(&mut denominators);
        let coefficients: Vec<Fr> = xs
            .iter()
            .zip(&denominators)
            .map(|(xj, inv)| {
                let numerator: Fr = xs.iter().filter(|xm| *xm != xj).product();
                numerator * inv
            })
            .collect();
        let bases: Vec<G1Affine> = chosen.iter().map(|s| s.value).collect();
        let pd = G1Projective::msm(&bases, &coefficients).expect("msm inputs same length");
        Ok(CombinedShare(pd))
    }

    /// Cross terms that depend only on the ciphertexts: `U_i` (G2) and `W_i`
    /// (G1) of Fig. 1, so they are computed before any share exists.
    pub struct PrecomputedCrossTerms {
        pub(crate) u: Vec<G2Projective>,
        pub(crate) w: Vec<G1Projective>,
        batch_hash: [u8; 32],
    }

    fn batch_hash(batch: &[CtHeader]) -> [u8; 32] {
        let mut h = Sha256::new();
        for ct in batch {
            h.update(ct.to_bytes());
        }
        h.finalize().into()
    }

    /// The naive O(B²) cross terms: for every `i`, one G2 and one G1 MSM of
    /// size `B − 1` with coefficients `1 / (x_j − x_i)`. The test oracle for
    /// the quasi-linear path and the small-batch fallback.
    pub fn cross_terms_naive(
        batch: &[CtHeader],
        xs: &[Fr],
    ) -> Result<(Vec<G2Projective>, Vec<G1Projective>), BteError> {
        let b = batch.len();
        if b == 0 || xs.len() != b || b > MAX_BATCH_SLOTS {
            return Err(BteError::BatchSize {
                expected: xs.len(),
                got: b,
            });
        }
        let ct2s: Vec<G2Affine> = batch.iter().map(|h| h.ct2).collect();
        let ct3s: Vec<G1Affine> = batch.iter().map(|h| h.ct3).collect();
        let mut u = Vec::with_capacity(b);
        let mut w = Vec::with_capacity(b);
        // One row of 1 / (x_j − x_i) at a time: O(B) memory.
        let mut coeffs = vec![Fr::ONE; b];
        for i in 0..b {
            for j in 0..b {
                coeffs[j] = if i == j { Fr::ONE } else { xs[j] - xs[i] };
            }
            batch_inversion(&mut coeffs);
            coeffs[i] = Fr::zero();
            u.push(G2Projective::msm(&ct2s, &coeffs).expect("msm inputs same length"));
            w.push(G1Projective::msm(&ct3s, &coeffs).expect("msm inputs same length"));
        }
        Ok((u, w))
    }

    /// How the cross terms are computed. See `poly.rs` for the measurement
    /// behind the default.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum CrossTermStrategy {
        /// Naive below `poly::FAST_PATH_MIN_BATCH`, quasi-linear above.
        Auto,
        /// `B` MSMs of size `B` per group.
        Naive,
        /// The paper's subproduct-tree evaluation (§4).
        Fast,
    }

    /// Admit the batch and precompute its cross terms with the default
    /// strategy.
    pub fn pre_decrypt(
        params: &PublicParams,
        batch: &[CtHeader],
    ) -> Result<PrecomputedCrossTerms, BteError> {
        pre_decrypt_with(params, batch, CrossTermStrategy::Auto)
    }

    /// Admit the batch and precompute its cross terms.
    pub fn pre_decrypt_with(
        params: &PublicParams,
        batch: &[CtHeader],
        strategy: CrossTermStrategy,
    ) -> Result<PrecomputedCrossTerms, BteError> {
        let xs = check_batch(params, batch)?;
        let fast = match strategy {
            CrossTermStrategy::Auto => batch.len() >= crate::tbte::poly::FAST_PATH_MIN_BATCH,
            CrossTermStrategy::Naive => false,
            CrossTermStrategy::Fast => true,
        };
        let (u, w) = if fast {
            crate::tbte::poly::cross_terms_fast(batch, &xs)?
        } else {
            cross_terms_naive(batch, &xs)?
        };
        Ok(PrecomputedCrossTerms {
            u,
            w,
            batch_hash: batch_hash(batch),
        })
    }

    /// The KEM secret of slot `i`: `S_i = (pd − W_i) ∘ ct2_i + ct3_i ∘ U_i`.
    pub fn slot_secret(
        pre: &PrecomputedCrossTerms,
        combined: &CombinedShare,
        header: &CtHeader,
        i: usize,
    ) -> Option<PairingOutput<E>> {
        let (u, w) = (pre.u.get(i)?, pre.w.get(i)?);
        let left = (combined.0 - w).into_affine();
        Some(E::multi_pairing(
            [left, header.ct3],
            [header.ct2.into_group(), *u],
        ))
    }

    /// Open every slot. A slot whose DEM tag fails is returned with
    /// `valid == false` and an empty payload; the rest of the batch is
    /// unaffected (Fig. 1's decryption is per slot).
    pub fn finalize(
        params: &PublicParams,
        pre: &PrecomputedCrossTerms,
        combined: &CombinedShare,
        batch: &[Ciphertext],
    ) -> Result<Vec<crate::RecoveredPayload>, BteError> {
        let headers: Vec<CtHeader> = batch.iter().map(|ct| ct.header()).collect();
        if pre.batch_hash != batch_hash(&headers) || pre.u.len() != batch.len() {
            return Err(BteError::InvalidParams(
                "cross-terms were computed for a different batch".into(),
            ));
        }
        let out = batch
            .iter()
            .zip(&headers)
            .enumerate()
            .map(|(i, (ct, h))| {
                let Some(secret) = slot_secret(pre, combined, h, i) else {
                    return crate::RecoveredPayload {
                        payload: Vec::new(),
                        valid: false,
                    };
                };
                let key = dem_key(&secret, &ct.ct1, &ct.ct2, &ct.ct3);
                let aad = dem_aad(params, &ct.context_hash, &ct.ct1, &ct.ct2, &ct.ct3);
                let cipher = ChaCha20Poly1305::new((&key).into());
                match cipher.decrypt(
                    &Nonce::default(),
                    Payload {
                        msg: &ct.body,
                        aad: &aad,
                    },
                ) {
                    Ok(payload) if payload.len() <= crate::MAX_PAYLOAD_BYTES => {
                        crate::RecoveredPayload {
                            payload,
                            valid: true,
                        }
                    }
                    _ => crate::RecoveredPayload {
                        payload: Vec::new(),
                        valid: false,
                    },
                }
            })
            .collect();
        Ok(out)
    }

    /// Full recovery: verify shares, take `t` valid ones, combine, open.
    pub fn recover(
        params: &PublicParams,
        batch: &[Ciphertext],
        shares: &[Share],
    ) -> Result<Vec<crate::RecoveredPayload>, BteError> {
        let headers: Vec<CtHeader> = batch.iter().map(|ct| ct.header()).collect();
        let pre = pre_decrypt(params, &headers)?;
        let valid: Vec<Share> = shares
            .iter()
            .filter(|s| verify_share_admitted(params, &headers, s))
            .copied()
            .collect();
        let combined = combine(params, &valid)?;
        finalize(params, &pre, &combined, batch)
    }
}

#[cfg(feature = "full")]
pub mod poly;
