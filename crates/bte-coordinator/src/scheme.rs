//! The two encryption schemes a committee can run, behind one surface.
//!
//! v0 is the simple-bte wrapper (fixed batch B, dealer-trusted keys). v1 is
//! the transparent-setup scheme from a DKG (`bte_crypto::tbte`): no batch
//! bound, one proof per ciphertext checked at the door, and every
//! ciphertext bound to the condition it was sealed for. Wire blobs carry
//! their scheme in the first four bytes (`BTE0` / `BTE1`), so every parse
//! here dispatches on the magic and nothing downstream guesses.

use anyhow::{anyhow, Context, Result};
use bte_crypto::tbte;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
    V0,
    V1,
}

impl Scheme {
    pub fn as_str(self) -> &'static str {
        match self {
            Scheme::V0 => "v0",
            Scheme::V1 => "v1",
        }
    }

    pub fn parse(s: &str) -> Option<Scheme> {
        match s {
            "v0" => Some(Scheme::V0),
            "v1" => Some(Scheme::V1),
            _ => None,
        }
    }

    fn of_blob(blob: &[u8]) -> Option<Scheme> {
        match blob.get(..4)? {
            b"BTE0" => Some(Scheme::V0),
            b"BTE1" => Some(Scheme::V1),
            _ => None,
        }
    }
}

/// The batch stride of a v1 committee: one batch per condition, so this is
/// also the most slots a v1 condition can hold (one of them the decoy).
pub const V1_BATCH_STRIDE: usize = tbte::MAX_BATCH_SLOTS;

pub enum Keys {
    V0 {
        params: Arc<bte_crypto::PublicParams>,
        rk: Arc<bte_crypto::RecoveryKey>,
    },
    V1 {
        params: Arc<tbte::PublicParams>,
    },
}

/// A cached committee: its scheme, its keys, and the numbers the engine
/// and the API read without touching the keys.
pub struct Committee {
    pub scheme: Scheme,
    pub keys: Keys,
    pub n: u16,
    pub t: u16,
    /// v0: the fixed batch size. v1: the batch stride (`V1_BATCH_STRIDE`).
    pub b: usize,
    pub digest: [u8; 32],
    /// v1 only: the DKG output digest. Zero for v0.
    pub setup_digest: [u8; 32],
}

impl Committee {
    pub fn parse(blob: &[u8]) -> Result<Committee> {
        match Scheme::of_blob(blob) {
            Some(Scheme::V0) => {
                let params = bte_crypto::PublicParams::from_bytes(blob)
                    .context("invalid v0 committee params blob")?;
                Ok(Committee {
                    scheme: Scheme::V0,
                    n: params.n,
                    t: params.t,
                    b: params.b as usize,
                    digest: params.digest(),
                    setup_digest: [0u8; 32],
                    keys: Keys::V0 {
                        rk: Arc::new(params.recovery_key()),
                        params: Arc::new(params),
                    },
                })
            }
            Some(Scheme::V1) => {
                let params = tbte::PublicParams::from_bytes(blob)
                    .context("invalid v1 committee params blob")?;
                Ok(Committee {
                    scheme: Scheme::V1,
                    n: params.n(),
                    t: params.t(),
                    b: V1_BATCH_STRIDE,
                    digest: params.digest(),
                    setup_digest: params.setup_digest(),
                    keys: Keys::V1 {
                        params: Arc::new(params),
                    },
                })
            }
            None => Err(anyhow!("unknown committee params magic")),
        }
    }

    pub fn v0(
        &self,
    ) -> Option<(
        &Arc<bte_crypto::PublicParams>,
        &Arc<bte_crypto::RecoveryKey>,
    )> {
        match &self.keys {
            Keys::V0 { params, rk } => Some((params, rk)),
            Keys::V1 { .. } => None,
        }
    }

    pub fn v1(&self) -> Option<&Arc<tbte::PublicParams>> {
        match &self.keys {
            Keys::V1 { params } => Some(params),
            Keys::V0 { .. } => None,
        }
    }

    /// v1 ciphertexts commit to the condition they are sealed for.
    pub fn context_for(condition_id: &str) -> Vec<u8> {
        tbte::condition_context(condition_id)
    }

    /// Seal the coordinator's own decoy payload for a condition.
    pub fn seal_decoy(
        &self,
        condition_id: &str,
        rng: &mut (impl bte_crypto::rand::Rng + bte_crypto::rand::CryptoRng),
    ) -> Sealed {
        let payload = bte_crypto::dummy_payload(rng);
        match &self.keys {
            Keys::V0 { params, .. } => Sealed::V0(
                bte_crypto::seal(params, &payload, rng).expect("dummy payload is under the cap"),
            ),
            Keys::V1 { params } => Sealed::V1(
                tbte::seal(params, &Self::context_for(condition_id), &payload, rng)
                    .expect("dummy payload is under the cap"),
            ),
        }
    }

    /// How many decoys a freeze adds to `real` ciphertexts. v0 pads to a
    /// multiple of B. v1 adds exactly one, which keeps the batch randomness
    /// from summing to zero (a sealer's k, -k pair) and makes an empty
    /// condition still reveal.
    pub fn decoys_for(&self, real: usize) -> usize {
        match self.scheme {
            Scheme::V0 => real.div_ceil(self.b).max(1) * self.b - real,
            Scheme::V1 => 1,
        }
    }

    /// The most real ciphertexts a condition may hold, if bounded.
    pub fn real_capacity(&self) -> Option<usize> {
        match self.scheme {
            Scheme::V0 => None,
            Scheme::V1 => Some(self.b - 1),
        }
    }
}

/// A parsed ciphertext of either scheme.
#[derive(Clone)]
pub enum Sealed {
    V0(bte_crypto::SealedCiphertext),
    V1(tbte::Ciphertext),
}

impl Sealed {
    /// Strict parse: magic, points on curve and in the subgroup, payload cap.
    pub fn parse(blob: &[u8]) -> Result<Sealed, String> {
        match Scheme::of_blob(blob) {
            Some(Scheme::V0) => bte_crypto::SealedCiphertext::from_bytes(blob)
                .map(Sealed::V0)
                .map_err(|e| e.to_string()),
            Some(Scheme::V1) => tbte::Ciphertext::from_bytes(blob)
                .map(Sealed::V1)
                .map_err(|e| e.to_string()),
            None => Err("unknown ciphertext magic (expected BTE0 or BTE1)".into()),
        }
    }

    pub fn scheme(&self) -> Scheme {
        match self {
            Sealed::V0(_) => Scheme::V0,
            Sealed::V1(_) => Scheme::V1,
        }
    }

    pub fn hash(&self) -> [u8; 32] {
        match self {
            Sealed::V0(ct) => ct.hash(),
            Sealed::V1(ct) => ct.hash(),
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        match self {
            Sealed::V0(ct) => ct.to_bytes(),
            Sealed::V1(ct) => ct.to_bytes(),
        }
    }

    /// v1 only: the KEM point, hex, for the per-condition uniqueness index.
    pub fn kem_point_hex(&self) -> Option<String> {
        match self {
            Sealed::V0(_) => None,
            Sealed::V1(ct) => Some(hex::encode(ct.kem_point_bytes())),
        }
    }

    /// Admission at the door: the ciphertext belongs to this committee's
    /// scheme and, for v1, its proof verifies and it was sealed for this
    /// condition. v0 has nothing to check beyond parsing.
    pub fn admit(&self, committee: &Committee, condition_id: &str) -> Result<(), String> {
        if self.scheme() != committee.scheme {
            return Err(format!(
                "ciphertext is {} but the committee runs {}",
                self.scheme().as_str(),
                committee.scheme.as_str()
            ));
        }
        if let (Sealed::V1(ct), Some(params)) = (self, committee.v1()) {
            if ct.context_hash != tbte::context_hash(&Committee::context_for(condition_id)) {
                return Err("ciphertext was sealed for another condition".into());
            }
            if !tbte::verify_ciphertext(params, &ct.header()) {
                return Err("ciphertext proof does not verify for this committee".into());
            }
        }
        Ok(())
    }
}

/// The public headers of a batch, in position order.
pub enum Headers {
    V0(Vec<bte_crypto::CtHeader>),
    V1(Vec<tbte::CtHeader>),
}

impl Headers {
    pub fn of(cts: &[Sealed]) -> Result<Headers> {
        let mut v0 = Vec::new();
        let mut v1 = Vec::new();
        for ct in cts {
            match ct {
                Sealed::V0(ct) => v0.push(ct.header()),
                Sealed::V1(ct) => v1.push(ct.header()),
            }
        }
        match (v0.is_empty(), v1.is_empty()) {
            (false, true) => Ok(Headers::V0(v0)),
            (true, false) => Ok(Headers::V1(v1)),
            (true, true) => Err(anyhow!("empty batch")),
            (false, false) => Err(anyhow!("a batch mixes schemes")),
        }
    }

    pub fn len(&self) -> usize {
        match self {
            Headers::V0(h) => h.len(),
            Headers::V1(h) => h.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Packed for the wire: v0 bare 48-byte points, v1 framed 320-byte headers.
    pub fn pack(&self) -> Vec<u8> {
        match self {
            Headers::V0(h) => {
                let mut out = Vec::with_capacity(h.len() * 48);
                for header in h {
                    out.extend_from_slice(&bte_crypto::wire::header_to_bytes(header));
                }
                out
            }
            Headers::V1(h) => tbte::wire::pack_headers(h),
        }
    }
}

/// A share of either scheme.
#[derive(Clone, Copy)]
pub enum AnyShare {
    V0(bte_crypto::Share),
    V1(tbte::Share),
}

impl AnyShare {
    pub fn parse(blob: &[u8]) -> Result<AnyShare, String> {
        match Scheme::of_blob(blob) {
            Some(Scheme::V0) => bte_crypto::Share::from_bytes(blob)
                .map(AnyShare::V0)
                .map_err(|e| e.to_string()),
            Some(Scheme::V1) => tbte::Share::from_bytes(blob)
                .map(AnyShare::V1)
                .map_err(|e| e.to_string()),
            None => Err("unknown share magic".into()),
        }
    }

    pub fn party_index(&self) -> u16 {
        match self {
            AnyShare::V0(s) => s.party_index,
            AnyShare::V1(s) => s.party_index,
        }
    }
}

/// Public verifiability, by scheme. False on any mismatch, never panics.
pub fn verify_share(committee: &Committee, headers: &Headers, share: &AnyShare) -> bool {
    match (&committee.keys, headers, share) {
        (Keys::V0 { params, .. }, Headers::V0(h), AnyShare::V0(s)) => {
            bte_crypto::verify_share(params, h, s)
        }
        (Keys::V1 { params }, Headers::V1(h), AnyShare::V1(s)) => tbte::verify_share(params, h, s),
        _ => false,
    }
}

/// Cross terms of either scheme; computed before any share exists.
pub enum CrossTerms {
    V0(bte_crypto::PrecomputedCrossTerms),
    V1(tbte::PrecomputedCrossTerms),
}

pub fn pre_decrypt(committee: &Committee, cts: &[Sealed]) -> Result<CrossTerms> {
    match &committee.keys {
        Keys::V0 { rk, .. } => {
            let cts: Vec<bte_crypto::SealedCiphertext> = cts
                .iter()
                .map(|c| match c {
                    Sealed::V0(ct) => Ok(ct.clone()),
                    Sealed::V1(_) => Err(anyhow!("v1 ciphertext in a v0 batch")),
                })
                .collect::<Result<_>>()?;
            Ok(CrossTerms::V0(bte_crypto::pre_decrypt(rk, &cts)?))
        }
        Keys::V1 { params } => {
            let headers = match Headers::of(cts)? {
                Headers::V1(h) => h,
                Headers::V0(_) => return Err(anyhow!("v0 ciphertext in a v1 batch")),
            };
            Ok(CrossTerms::V1(tbte::pre_decrypt(params, &headers)?))
        }
    }
}

/// Combine `t` verified shares and open every slot.
pub fn finalize(
    committee: &Committee,
    cross: &CrossTerms,
    shares: &[AnyShare],
    cts: &[Sealed],
) -> Result<Vec<bte_crypto::RecoveredPayload>> {
    match (&committee.keys, cross) {
        (Keys::V0 { rk, .. }, CrossTerms::V0(pre)) => {
            let shares: Vec<bte_crypto::Share> = shares
                .iter()
                .filter_map(|s| match s {
                    AnyShare::V0(s) => Some(*s),
                    AnyShare::V1(_) => None,
                })
                .collect();
            let cts: Vec<bte_crypto::SealedCiphertext> = cts
                .iter()
                .filter_map(|c| match c {
                    Sealed::V0(ct) => Some(ct.clone()),
                    Sealed::V1(_) => None,
                })
                .collect();
            let combined = bte_crypto::combine(&shares);
            Ok(bte_crypto::finalize(rk, pre, &combined, &cts)?)
        }
        (Keys::V1 { params }, CrossTerms::V1(pre)) => {
            let shares: Vec<tbte::Share> = shares
                .iter()
                .filter_map(|s| match s {
                    AnyShare::V1(s) => Some(*s),
                    AnyShare::V0(_) => None,
                })
                .collect();
            let cts: Vec<tbte::Ciphertext> = cts
                .iter()
                .filter_map(|c| match c {
                    Sealed::V1(ct) => Some(ct.clone()),
                    Sealed::V0(_) => None,
                })
                .collect();
            let combined = tbte::combine(params, &shares)?;
            Ok(tbte::finalize(params, pre, &combined, &cts)?)
        }
        _ => Err(anyhow!("cross terms and committee scheme disagree")),
    }
}
