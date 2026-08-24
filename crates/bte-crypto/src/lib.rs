//! bte-crypto: the only crate in this workspace touching group elements.
//!
//! Thin wrapper over commonware's simple-bte (see spec/API-MAP.md for the
//! function-by-function mapping). All pairing math, group FFTs, and the BTE
//! scheme itself live in simple-bte; this crate adds wire formats
//! (BTE_WIRE_V0), payload caps, per-slot validity, and an API shaped for the
//! coordinator / node / SDK.
//!
//! Feature flags:
//! - `seal-only`: wire types + `seal` — what the wasm SDK builds.
//! - `full`: adds `ceremony`, `partial`, `verify_share`, `pre_decrypt`,
//!   `finalize`, `recover`.

pub mod wire;

/// Re-export of the rand version simple-bte's API is built against
/// (ark-std 0.6 -> rand 0.8). Downstream crates should use this instead of
/// depending on `rand` directly, so RNG trait versions can never diverge.
pub use ark_std::rand;

/// OS-entropy RNG matching simple-bte's rand version (works on native and
/// wasm — getrandom picks the platform source).
pub fn os_rng() -> impl rand::Rng {
    use rand::SeedableRng;
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).expect("OS entropy unavailable");
    rand_chacha::ChaCha20Rng::from_seed(seed)
}

use ark_bls12_381::{Bls12_381, Fr, G1Affine, G2Affine};
use ark_std::rand::Rng;
use sha2::{Digest, Sha256};
use simple_bte::bte::EncryptionKey;

pub type E = Bls12_381;

/// Version tag prefixed to every wire type.
pub const BTE_WIRE_V0: &[u8; 4] = b"BTE0";

/// Hard payload cap, enforced at seal time and again when parsing wire bytes.
///
/// This is a policy number, not a cryptographic limit: the FO body is a
/// keystream XOR (`ct2 = H_M(K) xor payload`), so any length works. It is also
/// NOT a threshold-cost limit — `partial` runs an MSM over 48-byte KEM headers
/// and never touches the payload, and dummy padding is 29 bytes a slot. What a
/// bigger payload actually costs is coordinator storage and reveal bandwidth.
/// 5 MiB covers documents, decks, and high-resolution images; video still wants
/// envelope encryption instead of going through the seal directly.
pub const MAX_PAYLOAD_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum BteError {
    #[error("payload exceeds {MAX_PAYLOAD_BYTES} bytes")]
    PayloadTooLarge,
    #[error("wire format error: {0}")]
    Wire(String),
    #[error("invalid parameters: {0}")]
    InvalidParams(String),
    #[error("batch size mismatch: expected {expected}, got {got}")]
    BatchSize { expected: usize, got: usize },
    #[error("not enough valid shares: need {need}, have {have}")]
    NotEnoughShares { need: usize, have: usize },
}

/// Public parameters for one committee. Carries ek, the punctured powers of h
/// (slot B+1 is the zero point), and per-operator verification values v_j^i.
/// Runtime pairing/FFT material is NOT stored here; see [`RecoveryKey`].
#[derive(Clone)]
pub struct PublicParams {
    pub n: u16,
    pub t: u16,
    pub b: u32,
    /// ek = [tau^{B+1}]_T
    pub ek: EncryptionKey<E>,
    /// powers_of_h[j] = [tau^j]_2 for j = 0..2B, slot B+1 zeroed (punctured).
    pub powers_of_h: Vec<G2Affine>,
    /// verification_keys[party][slot] = [sigma^{slot+1}_{party+1}]_2.
    pub verification_keys: Vec<Vec<G2Affine>>,
    digest: [u8; 32],
}

impl PublicParams {
    pub(crate) fn assemble(
        n: u16,
        t: u16,
        b: u32,
        ek: EncryptionKey<E>,
        powers_of_h: Vec<G2Affine>,
        verification_keys: Vec<Vec<G2Affine>>,
    ) -> Self {
        let mut p = PublicParams {
            n,
            t,
            b,
            ek,
            powers_of_h,
            verification_keys,
            digest: [0u8; 32],
        };
        p.digest = Sha256::digest(p.to_bytes()).into();
        p
    }

    /// Stable digest: sha256 over the canonical wire bytes.
    pub fn digest(&self) -> [u8; 32] {
        self.digest
    }
}

/// Shamir shares of tau^1..tau^B held by one operator. Never leaves an
/// encrypted keystore or a gitignored dev directory. Deliberately no Debug.
#[derive(Clone)]
pub struct OperatorSecret {
    /// 1-based party index.
    pub party_index: u16,
    pub(crate) shares: Vec<Fr>,
}

/// FO-transformed sealed ciphertext: 48-byte KEM header + 16-byte key mask +
/// payload-length keystream body. See spec/index.md section 3.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SealedCiphertext {
    pub ct0: G1Affine,
    pub ct1: [u8; 16],
    pub ct2: Vec<u8>,
}

impl SealedCiphertext {
    /// Content address: sha256 over the wire bytes.
    pub fn hash(&self) -> [u8; 32] {
        Sha256::digest(self.to_bytes()).into()
    }

    pub fn header(&self) -> CtHeader {
        CtHeader(self.ct0)
    }

    #[cfg(feature = "full")]
    fn as_fo(&self) -> simple_bte::bte::fo::FoCiphertext<E> {
        simple_bte::bte::fo::FoCiphertext {
            ct0: self.ct0,
            ct1: self.ct1,
            ct2: self.ct2.clone(),
        }
    }
}

/// The 48-byte KEM header `[k]_1` — all an operator needs to compute a share.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CtHeader(pub G1Affine);

/// One operator's partial decryption for a whole frozen batch: a single
/// 48-byte G1 element, independent of B.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Share {
    /// 1-based party index.
    pub party_index: u16,
    pub value: G1Affine,
}

/// Sort a batch into freeze order: ascending ct_hash. Positions are the
/// resulting indices — a pure function of the ct_hash set (invariant 6).
pub fn sort_by_ct_hash(cts: &mut [SealedCiphertext]) {
    cts.sort_by_cached_key(|ct| ct.hash());
}

/// Seal a payload under the committee's encryption key (FO transform,
/// `simple_bte::bte::fo::encrypt`). Takes no batch number and no position.
pub fn seal(
    params: &PublicParams,
    payload: &[u8],
    rng: &mut impl Rng,
) -> Result<SealedCiphertext, BteError> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(BteError::PayloadTooLarge);
    }
    let ct = simple_bte::bte::fo::encrypt(&params.ek, payload, rng);
    Ok(SealedCiphertext {
        ct0: ct.ct0,
        ct1: ct.ct1,
        ct2: ct.ct2,
    })
}

#[cfg(feature = "full")]
pub use full::*;

#[cfg(feature = "full")]
mod full {
    use super::*;
    use ark_ec::pairing::Pairing;
    use ark_ec::{AffineRepr, CurveGroup, PrimeGroup, VariableBaseMSM};
    use ark_ff::Zero;
    use ark_poly::{EvaluationDomain, Radix2EvaluationDomain};
    use simple_bte::bte::decryption::CrossTerms;
    use simple_bte::bte::fo;
    use simple_bte::bte::fo::FoCiphertext;
    use simple_bte::bte::{DecryptionKey, PartialDecryption};

    /// Trusted dealer ceremony (v0 trust model): runs
    /// `simple_bte::bte::crs::setup`, which samples tau, publishes the
    /// punctured powers, Shamir-shares tau^1..tau^B, and drops tau on return.
    /// The dealer is the process that calls this; destroy the returned
    /// secrets responsibly.
    pub fn ceremony(
        n: u16,
        t: u16,
        b: u32,
        rng: &mut impl Rng,
    ) -> Result<(PublicParams, Vec<OperatorSecret>), BteError> {
        if n == 0 || t == 0 || t > n {
            return Err(BteError::InvalidParams(
                "need 1 <= t <= n (and n < 65536)".into(),
            ));
        }
        if b == 0 {
            return Err(BteError::InvalidParams("batch size must be >= 1".into()));
        }
        let (ek, dk, sks) =
            simple_bte::bte::crs::setup::<E>(b as usize, n as usize, t as usize, rng);

        // Keep only the affine material; prepared/FFT forms are rebuilt
        // deterministically by RecoveryKey.
        let verification_keys = sks
            .iter()
            .map(|sk| {
                sk.shares
                    .iter()
                    .map(|s| (<E as Pairing>::G2::generator() * s).into_affine())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        let params = PublicParams::assemble(n, t, b, ek, dk.powers_of_h_affine, verification_keys);
        let secrets = sks
            .into_iter()
            .map(|sk| OperatorSecret {
                party_index: sk.party_index as u16,
                shares: sk.shares,
            })
            .collect();
        Ok((params, secrets))
    }

    /// Runtime recovery material rebuilt from [`PublicParams`]: prepared
    /// pairing forms and the precomputed FFT of the circular h-vector.
    /// Mirrors the construction in simple-bte `crs.rs` (see DEVIATIONS.md);
    /// build once per committee and reuse.
    pub struct RecoveryKey {
        pub(crate) dk: DecryptionKey<E>,
    }

    impl PublicParams {
        pub fn recovery_key(&self) -> RecoveryKey {
            let b = self.b as usize;
            let h_affine = self.powers_of_h.clone();
            let powers_of_h: Vec<<E as Pairing>::G2Prepared> =
                h_affine.iter().cloned().map(Into::into).collect();
            let verification_keys: Vec<Vec<<E as Pairing>::G2Prepared>> = self
                .verification_keys
                .iter()
                .map(|vk| vk.iter().cloned().map(Into::into).collect())
                .collect();

            // Circular h-vector layout exactly as simple-bte crs.rs builds it.
            let fft_size = (2 * b).next_power_of_two();
            let fft_domain =
                Radix2EvaluationDomain::<Fr>::new(fft_size).expect("fft_size within Fr 2-adicity");
            let mut g2_vec: Vec<<E as Pairing>::G2> = vec![<E as Pairing>::G2::zero(); fft_size];
            for k in 0..b {
                g2_vec[k] = h_affine[b + 1 - k].into_group();
            }
            for j in 1..b {
                g2_vec[fft_size - j] = h_affine[b + 1 + j].into_group();
            }
            fft_domain.fft_in_place(&mut g2_vec);
            let fft_h: Vec<<E as Pairing>::G2Prepared> =
                <E as Pairing>::G2::normalize_batch(&g2_vec)
                    .into_iter()
                    .map(Into::into)
                    .collect();

            RecoveryKey {
                dk: DecryptionKey {
                    batch_size: b,
                    num_parties: self.n as usize,
                    threshold: self.t as usize,
                    powers_of_h_affine: h_affine,
                    powers_of_h,
                    verification_keys,
                    fft_size,
                    fft_domain,
                    fft_h,
                },
            }
        }
    }

    /// One share per operator per batch: pd_j = sum_i sigma_j^i * ct_{i,0}.
    /// Identical MSM to `fo::partial_decrypt`, taken over bare headers.
    pub fn partial(secret: &OperatorSecret, batch: &[CtHeader]) -> Result<Share, BteError> {
        if batch.len() != secret.shares.len() {
            return Err(BteError::BatchSize {
                expected: secret.shares.len(),
                got: batch.len(),
            });
        }
        let bases: Vec<G1Affine> = batch.iter().map(|h| h.0).collect();
        let value = <E as Pairing>::G1::msm(&bases, &secret.shares)
            .expect("msm inputs same length")
            .into_affine();
        Ok(Share {
            party_index: secret.party_index,
            value,
        })
    }

    /// Public verifiability: e(pd_j, g_2) == sum_i e(ct_{i,0}, v_j^i).
    /// Identical pairing check to `fo::verify_partial_decryption`, taken over
    /// bare headers. Returns false (never panics) on any mismatch.
    pub fn verify_share(params: &PublicParams, batch: &[CtHeader], share: &Share) -> bool {
        if batch.len() != params.b as usize {
            return false;
        }
        let party = share.party_index as usize;
        if party == 0 || party > params.n as usize {
            return false;
        }
        let vk = &params.verification_keys[party - 1];
        let lhs = E::pairing(share.value, <E as Pairing>::G2::generator());
        let rhs = E::multi_pairing(batch.iter().map(|h| h.0), vk.iter().cloned());
        lhs == rhs
    }

    /// Cross-terms from `fo::predecrypt_fft` — depends only on ciphertexts
    /// and public params, so it runs before any share exists (pipelining).
    pub struct PrecomputedCrossTerms {
        cross: CrossTerms<E>,
        batch_hash: [u8; 32],
    }

    fn batch_hash(batch: &[SealedCiphertext]) -> [u8; 32] {
        let mut h = Sha256::new();
        for ct in batch {
            h.update(ct.hash());
        }
        h.finalize().into()
    }

    pub fn pre_decrypt(
        rk: &RecoveryKey,
        batch: &[SealedCiphertext],
    ) -> Result<PrecomputedCrossTerms, BteError> {
        if batch.len() != rk.dk.batch_size {
            return Err(BteError::BatchSize {
                expected: rk.dk.batch_size,
                got: batch.len(),
            });
        }
        let fo_cts: Vec<FoCiphertext<E>> = batch.iter().map(|ct| ct.as_fo()).collect();
        Ok(PrecomputedCrossTerms {
            cross: fo::predecrypt_fft(&rk.dk, &fo_cts),
            batch_hash: batch_hash(batch),
        })
    }

    /// t-of-n Lagrange combination (`fo::combine`, interpolation at x=0).
    pub struct CombinedShare(pub(crate) <E as Pairing>::G1);

    pub fn combine(shares: &[Share]) -> CombinedShare {
        let pds: Vec<PartialDecryption<E>> = shares
            .iter()
            .map(|s| PartialDecryption {
                value: s.value.into_group(),
                party_index: s.party_index as usize,
            })
            .collect();
        CombinedShare(fo::combine::<E>(&pds))
    }

    /// One recovered batch slot. `valid == false` means the ciphertext failed
    /// the FO re-derivation check (mauled or malformed); the payload bytes are
    /// whatever the keystream produced and must be treated as garbage.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct RecoveredPayload {
        pub payload: Vec<u8>,
        pub valid: bool,
    }

    /// Finalization: B pairings + per-slot FO validity. Per-slot check is
    /// `[k_i]_1 == ct0_i` over the re-derived randomness from
    /// `fo::helper_finalize_bandwidth_optimized`, so one mauled ciphertext
    /// never poisons the batch.
    pub fn finalize(
        rk: &RecoveryKey,
        pre: &PrecomputedCrossTerms,
        combined: &CombinedShare,
        batch: &[SealedCiphertext],
    ) -> Result<Vec<RecoveredPayload>, BteError> {
        if batch.len() != rk.dk.batch_size {
            return Err(BteError::BatchSize {
                expected: rk.dk.batch_size,
                got: batch.len(),
            });
        }
        if pre.batch_hash != batch_hash(batch) {
            return Err(BteError::InvalidParams(
                "cross-terms were computed for a different batch".into(),
            ));
        }
        let fo_cts: Vec<FoCiphertext<E>> = batch.iter().map(|ct| ct.as_fo()).collect();
        let (messages, hints) =
            fo::helper_finalize_bandwidth_optimized(&rk.dk, &combined.0, &fo_cts, &pre.cross);
        let out = messages
            .into_iter()
            .zip(hints.randomness)
            .zip(&fo_cts)
            .map(|((payload, k), ct)| RecoveredPayload {
                valid: (<E as Pairing>::G1::generator() * k).into_affine() == ct.ct0
                    && payload.len() <= MAX_PAYLOAD_BYTES,
                payload,
            })
            .collect();
        Ok(out)
    }

    /// Full recovery: verify shares, take t valid ones, Lagrange-combine,
    /// FFT-recover, open every slot. Errors explicitly with fewer than t
    /// valid shares — never returns garbage.
    pub fn recover(
        params: &PublicParams,
        batch: &[SealedCiphertext],
        shares: &[Share],
    ) -> Result<Vec<RecoveredPayload>, BteError> {
        let headers: Vec<CtHeader> = batch.iter().map(|ct| ct.header()).collect();
        let mut seen = std::collections::HashSet::new();
        let valid: Vec<Share> = shares
            .iter()
            .filter(|s| seen.insert(s.party_index))
            .filter(|s| verify_share(params, &headers, s))
            .take(params.t as usize)
            .copied()
            .collect();
        if valid.len() < params.t as usize {
            return Err(BteError::NotEnoughShares {
                need: params.t as usize,
                have: valid.len(),
            });
        }
        let rk = params.recovery_key();
        let pre = pre_decrypt(&rk, batch)?;
        let combined = combine(&valid);
        finalize(&rk, &pre, &combined, batch)
    }

    /// Deterministic dummy payload for batch padding. Marked so reveals can
    /// label dummy slots; uniqueness comes from the random nonce.
    pub fn dummy_payload(rng: &mut impl Rng) -> Vec<u8> {
        let mut out = b"BTE_DUMMY_V0:".to_vec();
        let mut nonce = [0u8; 16];
        rng.fill(&mut nonce);
        out.extend_from_slice(&nonce);
        out
    }

    pub fn is_dummy_payload(payload: &[u8]) -> bool {
        payload.starts_with(b"BTE_DUMMY_V0:")
    }
}
