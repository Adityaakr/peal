//! Account identity and signed envelopes.
//!
//! An account is a field element `A`, the paper's public identifier. Peal
//! derives it from an ed25519 spend key *and the ledger namespace*, so the
//! same key yields a different `A` on every namespace and a proof (whose
//! statement names `A`) can never be replayed across namespaces. The value
//! authority is the proof; the key only authorizes registration and signs
//! submission envelopes so the ledger can attribute and rate-limit them.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::encoding::{fr_hex, fr_to_bytes};
use crate::params::ACCOUNT_ID_DOMAIN;
use crate::{Error, Fr, Result};
use ark_ff::PrimeField;

/// Wire magic for every signed envelope, one byte of type after it.
pub const ENVELOPE_MAGIC: &[u8; 4] = b"PLK0";
pub const ENVELOPE_REGISTER: u8 = 1;
pub const ENVELOPE_OP: u8 = 2;
pub const ENVELOPE_KEY_BINDING: u8 = 3;
pub const ENVELOPE_INBOX_AUTH: u8 = 4;

/// A ledger namespace: 32 bytes naming one asset domain (chain, token,
/// gateway, ledger). Built by [`namespace_id`].
pub type Namespace = [u8; 32];

pub fn namespace_id(label: &str) -> Namespace {
    let mut h = Sha256::new();
    h.update(b"peal-links/v1/namespace");
    h.update([0u8]);
    h.update(label.as_bytes());
    h.finalize().into()
}

/// The account identifier for `pk` on `namespace`.
pub fn account_id(namespace: &Namespace, pk: &VerifyingKey) -> Fr {
    let mut h = Sha256::new();
    h.update(ACCOUNT_ID_DOMAIN);
    h.update([0u8]);
    h.update(namespace);
    h.update(pk.as_bytes());
    let digest = h.finalize();
    Fr::from_le_bytes_mod_order(&digest)
}

/// The spend key: ed25519, generated from OS randomness, never derived from
/// anything visible.
#[derive(Clone)]
pub struct SpendKey(SigningKey);

impl SpendKey {
    pub fn generate<R: ark_std::rand::CryptoRng + ark_std::rand::RngCore>(rng: &mut R) -> Self {
        Self(SigningKey::generate(rng))
    }

    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Self(SigningKey::from_bytes(seed))
    }

    pub fn seed(&self) -> [u8; 32] {
        self.0.to_bytes()
    }

    pub fn public(&self) -> VerifyingKey {
        self.0.verifying_key()
    }

    pub fn account_id(&self, namespace: &Namespace) -> Fr {
        account_id(namespace, &self.public())
    }

    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.0.sign(msg).to_bytes()
    }
}

/// Registration: binds `A = account_id(namespace, pk)` to its initial
/// commitment `com0 = Com_acct(0, root_empty; r_A)`. The paper's R_reg opens
/// that commitment; since the initial balance is zero and the empty root is
/// public, opening it means revealing `r_A`, which the ledger uses to
/// recompute `com0` itself. Nothing else about the account is ever public:
/// the first operation replaces `r_A` with fresh randomness.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RegisterEnvelope {
    #[serde(with = "hex_32")]
    pub namespace: Namespace,
    #[serde(with = "hex_32")]
    pub pubkey: [u8; 32],
    /// `r_A`, the opening randomness of the initial commitment.
    #[serde(with = "fr_hex")]
    pub randomness: Fr,
    #[serde(with = "hex_64")]
    pub signature: [u8; 64],
}

impl RegisterEnvelope {
    pub fn signing_bytes(namespace: &Namespace, pubkey: &[u8; 32], randomness: &Fr) -> Vec<u8> {
        let mut m = Vec::with_capacity(4 + 1 + 32 + 32 + 32);
        m.extend_from_slice(ENVELOPE_MAGIC);
        m.push(ENVELOPE_REGISTER);
        m.extend_from_slice(namespace);
        m.extend_from_slice(pubkey);
        m.extend_from_slice(&fr_to_bytes(randomness));
        m
    }

    pub fn sign(key: &SpendKey, namespace: Namespace, randomness: Fr) -> Self {
        let pubkey = key.public().to_bytes();
        let signature = key.sign(&Self::signing_bytes(&namespace, &pubkey, &randomness));
        Self {
            namespace,
            pubkey,
            randomness,
            signature,
        }
    }

    /// Verify the signature and return the account id it registers.
    pub fn verify(&self, expected_namespace: &Namespace) -> Result<Fr> {
        if &self.namespace != expected_namespace {
            return Err(Error::WrongNamespace);
        }
        let pk = VerifyingKey::from_bytes(&self.pubkey).map_err(|_| Error::BadSignature)?;
        let sig = Signature::from_bytes(&self.signature);
        pk.verify(
            &Self::signing_bytes(&self.namespace, &self.pubkey, &self.randomness),
            &sig,
        )
        .map_err(|_| Error::BadSignature)?;
        Ok(account_id(&self.namespace, &pk))
    }
}

/// An operation as it travels to the ledger: the paper's public record
/// `(A, com', rho, root_rho, pi)` plus the namespace and circuit id it is
/// bound to, and the account key's signature over all of it.
///
/// `com` (the old commitment) is carried as a claim the ledger checks
/// against its own state before doing any expensive work: an operation made
/// against a commitment the account no longer holds is rejected as stale
/// without a pairing. The proof is always verified against the ledger's own
/// value, never the submitted one, so two operations racing from the same
/// old state resolve deterministically by order of application.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpEnvelope {
    #[serde(with = "hex_32")]
    pub namespace: Namespace,
    #[serde(with = "hex_32")]
    pub circuit_id: [u8; 32],
    #[serde(with = "fr_hex")]
    pub account: Fr,
    #[serde(with = "fr_hex")]
    pub com: Fr,
    #[serde(with = "fr_hex")]
    pub com_new: Fr,
    #[serde(with = "fr_hex")]
    pub receipt: Fr,
    #[serde(with = "fr_hex")]
    pub root: Fr,
    /// 128 bytes, compressed. Decoded and validated by the ledger STF.
    #[serde(with = "hex_vec")]
    pub proof: Vec<u8>,
    #[serde(with = "hex_32")]
    pub pubkey: [u8; 32],
    #[serde(with = "hex_64")]
    pub signature: [u8; 64],
}

impl OpEnvelope {
    #[allow(clippy::too_many_arguments)]
    pub fn signing_bytes(
        namespace: &Namespace,
        circuit_id: &[u8; 32],
        account: &Fr,
        com: &Fr,
        com_new: &Fr,
        receipt: &Fr,
        root: &Fr,
        proof: &[u8],
        pubkey: &[u8; 32],
    ) -> Vec<u8> {
        let mut m = Vec::with_capacity(4 + 1 + 32 * 7 + proof.len() + 32);
        m.extend_from_slice(ENVELOPE_MAGIC);
        m.push(ENVELOPE_OP);
        m.extend_from_slice(namespace);
        m.extend_from_slice(circuit_id);
        m.extend_from_slice(&fr_to_bytes(account));
        m.extend_from_slice(&fr_to_bytes(com));
        m.extend_from_slice(&fr_to_bytes(com_new));
        m.extend_from_slice(&fr_to_bytes(receipt));
        m.extend_from_slice(&fr_to_bytes(root));
        m.extend_from_slice(proof);
        m.extend_from_slice(pubkey);
        m
    }

    #[allow(clippy::too_many_arguments)]
    pub fn sign(
        key: &SpendKey,
        namespace: Namespace,
        circuit_id: [u8; 32],
        account: Fr,
        com: Fr,
        com_new: Fr,
        receipt: Fr,
        root: Fr,
        proof: Vec<u8>,
    ) -> Self {
        let pubkey = key.public().to_bytes();
        let signature = key.sign(&Self::signing_bytes(
            &namespace,
            &circuit_id,
            &account,
            &com,
            &com_new,
            &receipt,
            &root,
            &proof,
            &pubkey,
        ));
        Self {
            namespace,
            circuit_id,
            account,
            com,
            com_new,
            receipt,
            root,
            proof,
            pubkey,
            signature,
        }
    }

    /// Signature valid and the signing key is the one `account` was derived
    /// from on this namespace.
    pub fn verify_signature(&self) -> Result<()> {
        let pk = VerifyingKey::from_bytes(&self.pubkey).map_err(|_| Error::BadSignature)?;
        if account_id(&self.namespace, &pk) != self.account {
            return Err(Error::BadSignature);
        }
        let sig = Signature::from_bytes(&self.signature);
        pk.verify(
            &Self::signing_bytes(
                &self.namespace,
                &self.circuit_id,
                &self.account,
                &self.com,
                &self.com_new,
                &self.receipt,
                &self.root,
                &self.proof,
                &self.pubkey,
            ),
            &sig,
        )
        .map_err(|_| Error::BadSignature)
    }
}

/// Binds an account to its receipt-encryption public key, signed by the
/// spend key. The inbox directory stores the latest by `seq`; a client that
/// reads the directory re-verifies the signature, so the directory cannot
/// substitute a key.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeyBinding {
    #[serde(with = "hex_32")]
    pub namespace: Namespace,
    #[serde(with = "fr_hex")]
    pub account: Fr,
    #[serde(with = "hex_32")]
    pub enc_pubkey: [u8; 32],
    /// Rotation counter; the directory keeps the highest.
    pub seq: u64,
    #[serde(with = "hex_32")]
    pub pubkey: [u8; 32],
    #[serde(with = "hex_64")]
    pub signature: [u8; 64],
}

impl KeyBinding {
    fn signing_bytes(
        namespace: &Namespace,
        account: &Fr,
        enc_pubkey: &[u8; 32],
        seq: u64,
        pubkey: &[u8; 32],
    ) -> Vec<u8> {
        let mut m = Vec::with_capacity(4 + 1 + 32 * 4 + 8);
        m.extend_from_slice(ENVELOPE_MAGIC);
        m.push(ENVELOPE_KEY_BINDING);
        m.extend_from_slice(namespace);
        m.extend_from_slice(&fr_to_bytes(account));
        m.extend_from_slice(enc_pubkey);
        m.extend_from_slice(&seq.to_le_bytes());
        m.extend_from_slice(pubkey);
        m
    }

    pub fn sign(key: &SpendKey, namespace: Namespace, enc_pubkey: [u8; 32], seq: u64) -> Self {
        let account = key.account_id(&namespace);
        let pubkey = key.public().to_bytes();
        let signature = key.sign(&Self::signing_bytes(
            &namespace,
            &account,
            &enc_pubkey,
            seq,
            &pubkey,
        ));
        Self {
            namespace,
            account,
            enc_pubkey,
            seq,
            pubkey,
            signature,
        }
    }

    pub fn verify(&self) -> Result<()> {
        let pk = VerifyingKey::from_bytes(&self.pubkey).map_err(|_| Error::BadSignature)?;
        if account_id(&self.namespace, &pk) != self.account {
            return Err(Error::BadSignature);
        }
        pk.verify(
            &Self::signing_bytes(
                &self.namespace,
                &self.account,
                &self.enc_pubkey,
                self.seq,
                &self.pubkey,
            ),
            &Signature::from_bytes(&self.signature),
        )
        .map_err(|_| Error::BadSignature)
    }
}

/// Proof of account control for reading an inbox: a signature over the
/// account and a timestamp the server requires to be recent. Stateless, so
/// a replay is bounded to the freshness window and only ever re-reads what
/// the account could read anyway.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct InboxAuth {
    #[serde(with = "hex_32")]
    pub namespace: Namespace,
    #[serde(with = "fr_hex")]
    pub account: Fr,
    pub timestamp: u64,
    #[serde(with = "hex_32")]
    pub pubkey: [u8; 32],
    #[serde(with = "hex_64")]
    pub signature: [u8; 64],
}

impl InboxAuth {
    fn signing_bytes(
        namespace: &Namespace,
        account: &Fr,
        timestamp: u64,
        pubkey: &[u8; 32],
    ) -> Vec<u8> {
        let mut m = Vec::with_capacity(4 + 1 + 32 * 3 + 8);
        m.extend_from_slice(ENVELOPE_MAGIC);
        m.push(ENVELOPE_INBOX_AUTH);
        m.extend_from_slice(namespace);
        m.extend_from_slice(&fr_to_bytes(account));
        m.extend_from_slice(&timestamp.to_le_bytes());
        m.extend_from_slice(pubkey);
        m
    }

    pub fn sign(key: &SpendKey, namespace: Namespace, timestamp: u64) -> Self {
        let account = key.account_id(&namespace);
        let pubkey = key.public().to_bytes();
        let signature = key.sign(&Self::signing_bytes(
            &namespace, &account, timestamp, &pubkey,
        ));
        Self {
            namespace,
            account,
            timestamp,
            pubkey,
            signature,
        }
    }

    /// Valid signature, right account, and `timestamp` within `window`
    /// seconds of `now`.
    pub fn verify(&self, now: u64, window: u64) -> Result<()> {
        if self.timestamp.abs_diff(now) > window {
            return Err(Error::BadSignature);
        }
        let pk = VerifyingKey::from_bytes(&self.pubkey).map_err(|_| Error::BadSignature)?;
        if account_id(&self.namespace, &pk) != self.account {
            return Err(Error::BadSignature);
        }
        pk.verify(
            &Self::signing_bytes(&self.namespace, &self.account, self.timestamp, &self.pubkey),
            &Signature::from_bytes(&self.signature),
        )
        .map_err(|_| Error::BadSignature)
    }
}

pub mod hex_32 {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn serialize<S: Serializer>(x: &[u8; 32], s: S) -> std::result::Result<S::Ok, S::Error> {
        hex::encode(x).serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<[u8; 32], D::Error> {
        let s = String::deserialize(d)?;
        let v = hex::decode(s).map_err(serde::de::Error::custom)?;
        v.try_into()
            .map_err(|_| serde::de::Error::custom("expected 32 bytes"))
    }
}

pub mod hex_64 {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn serialize<S: Serializer>(x: &[u8; 64], s: S) -> std::result::Result<S::Ok, S::Error> {
        hex::encode(x).serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<[u8; 64], D::Error> {
        let s = String::deserialize(d)?;
        let v = hex::decode(s).map_err(serde::de::Error::custom)?;
        v.try_into()
            .map_err(|_| serde::de::Error::custom("expected 64 bytes"))
    }
}

pub mod hex_vec {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn serialize<S: Serializer>(x: &[u8], s: S) -> std::result::Result<S::Ok, S::Error> {
        hex::encode(x).serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        hex::decode(s).map_err(serde::de::Error::custom)
    }
}
