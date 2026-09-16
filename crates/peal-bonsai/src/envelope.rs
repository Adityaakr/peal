//! Authenticated encryption for receipt delivery and wallet backups.
//!
//! Receipt envelopes: the sender encrypts a receipt opening to the receiver's
//! x25519 key. An ephemeral sender key, HKDF-SHA256 over the shared secret,
//! XChaCha20-Poly1305 with a random 24-byte nonce, and associated data that
//! names the namespace and the recipient key so a ciphertext cannot be
//! replayed to another namespace or another key. The receiver's key is
//! separate from the spend key (an EVM address is not an encryption key, and
//! neither is the account's signing key).
//!
//! Backups: argon2id (explicit parameters below) turns a passphrase and a
//! random salt into a key; XChaCha20-Poly1305 seals the wallet JSON with the
//! format version as associated data.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

use crate::account::{hex_32, hex_vec, Namespace};
use crate::{Error, Result};

pub const ENVELOPE_VERSION: u8 = 1;
pub const BACKUP_VERSION: u8 = 1;
/// A receipt opening serializes to well under this; the inbox enforces it.
pub const MAX_ENVELOPE_PLAINTEXT: usize = 2048;

/// The receiver's encryption key pair. The secret lives in the wallet.
#[derive(Clone)]
pub struct EncryptionKey(StaticSecret);

impl EncryptionKey {
    pub fn generate<R: ark_std::rand::CryptoRng + ark_std::rand::RngCore>(rng: &mut R) -> Self {
        let mut seed = [0u8; 32];
        rng.fill_bytes(&mut seed);
        Self(StaticSecret::from(seed))
    }

    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self(StaticSecret::from(seed))
    }

    pub fn seed(&self) -> [u8; 32] {
        self.0.to_bytes()
    }

    pub fn public(&self) -> [u8; 32] {
        PublicKey::from(&self.0).to_bytes()
    }
}

/// A sealed receipt opening as it sits in the inbox.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReceiptEnvelope {
    pub version: u8,
    #[serde(with = "hex_32")]
    pub namespace: Namespace,
    /// Recipient x25519 public key (the inbox address).
    #[serde(with = "hex_32")]
    pub recipient: [u8; 32],
    /// Sender's ephemeral x25519 public key.
    #[serde(with = "hex_32")]
    pub ephemeral: [u8; 32],
    #[serde(with = "hex_vec")]
    pub nonce: Vec<u8>,
    #[serde(with = "hex_vec")]
    pub ciphertext: Vec<u8>,
}

fn aad(version: u8, namespace: &Namespace, recipient: &[u8; 32], ephemeral: &[u8; 32]) -> Vec<u8> {
    let mut a = Vec::with_capacity(4 + 1 + 96);
    a.extend_from_slice(b"PLKE");
    a.push(version);
    a.extend_from_slice(namespace);
    a.extend_from_slice(recipient);
    a.extend_from_slice(ephemeral);
    a
}

fn derive_key(shared: &[u8; 32], aad: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(b"peal-links/v1/receipt-envelope"), shared);
    let mut key = [0u8; 32];
    hk.expand(aad, &mut key)
        .expect("32 bytes is a valid hkdf length");
    key
}

/// Seal `plaintext` to `recipient` on `namespace`.
pub fn seal_receipt<R: ark_std::rand::CryptoRng + ark_std::rand::RngCore>(
    namespace: Namespace,
    recipient: [u8; 32],
    plaintext: &[u8],
    rng: &mut R,
) -> Result<ReceiptEnvelope> {
    if plaintext.len() > MAX_ENVELOPE_PLAINTEXT {
        return Err(Error::Wire("receipt envelope plaintext too large".into()));
    }
    let mut eph_seed = [0u8; 32];
    rng.fill_bytes(&mut eph_seed);
    let eph = StaticSecret::from(eph_seed);
    let ephemeral = PublicKey::from(&eph).to_bytes();
    let shared = eph.diffie_hellman(&PublicKey::from(recipient));
    if !shared.was_contributory() {
        return Err(Error::InvalidPoint);
    }
    let aad = aad(ENVELOPE_VERSION, &namespace, &recipient, &ephemeral);
    let key = derive_key(shared.as_bytes(), &aad);
    let mut nonce = [0u8; 24];
    rng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| Error::Wire("encryption failed".into()))?;
    Ok(ReceiptEnvelope {
        version: ENVELOPE_VERSION,
        namespace,
        recipient,
        ephemeral,
        nonce: nonce.to_vec(),
        ciphertext,
    })
}

/// Open an envelope with the recipient's key. Fails on any tampering, a
/// wrong recipient, or a wrong namespace.
pub fn open_receipt(
    key: &EncryptionKey,
    expected_namespace: &Namespace,
    env: &ReceiptEnvelope,
) -> Result<Vec<u8>> {
    if env.version != ENVELOPE_VERSION {
        return Err(Error::Wire("unsupported envelope version".into()));
    }
    if &env.namespace != expected_namespace {
        return Err(Error::WrongNamespace);
    }
    if env.recipient != key.public() {
        return Err(Error::Wire("envelope is for another recipient".into()));
    }
    if env.nonce.len() != 24 {
        return Err(Error::Wire("bad nonce".into()));
    }
    let shared = key.0.diffie_hellman(&PublicKey::from(env.ephemeral));
    if !shared.was_contributory() {
        return Err(Error::InvalidPoint);
    }
    let aad = aad(env.version, &env.namespace, &env.recipient, &env.ephemeral);
    let k = derive_key(shared.as_bytes(), &aad);
    let cipher = XChaCha20Poly1305::new((&k).into());
    cipher
        .decrypt(
            XNonce::from_slice(&env.nonce),
            Payload {
                msg: &env.ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| Error::BadSignature)
}

/// An encrypted wallet backup.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Backup {
    pub version: u8,
    pub kdf: String,
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
    #[serde(with = "hex_vec")]
    pub salt: Vec<u8>,
    #[serde(with = "hex_vec")]
    pub nonce: Vec<u8>,
    #[serde(with = "hex_vec")]
    pub ciphertext: Vec<u8>,
}

/// argon2id parameters: 64 MiB, 3 passes, 1 lane. Chosen to be about a
/// second in single-threaded wasm; explicit in the backup so they can be
/// raised later without breaking old files.
pub const BACKUP_M_COST_KIB: u32 = 64 * 1024;
pub const BACKUP_T_COST: u32 = 3;
pub const BACKUP_P_COST: u32 = 1;
pub const MIN_PASSPHRASE: usize = 10;

fn backup_key(passphrase: &str, salt: &[u8], m: u32, t: u32, p: u32) -> Result<[u8; 32]> {
    let params =
        Params::new(m, t, p, Some(32)).map_err(|e| Error::Wallet(format!("kdf params: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| Error::Wallet(format!("kdf: {e}")))?;
    Ok(key)
}

fn backup_aad(b: &Backup) -> Vec<u8> {
    let mut a = Vec::new();
    a.extend_from_slice(b"PLKB");
    a.push(b.version);
    a.extend_from_slice(b.kdf.as_bytes());
    a.extend_from_slice(&b.m_cost_kib.to_le_bytes());
    a.extend_from_slice(&b.t_cost.to_le_bytes());
    a.extend_from_slice(&b.p_cost.to_le_bytes());
    a.extend_from_slice(&b.salt);
    a
}

pub fn seal_backup<R: ark_std::rand::CryptoRng + ark_std::rand::RngCore>(
    passphrase: &str,
    plaintext: &[u8],
    rng: &mut R,
) -> Result<Backup> {
    if passphrase.chars().count() < MIN_PASSPHRASE {
        return Err(Error::Wallet(format!(
            "passphrase must be at least {MIN_PASSPHRASE} characters"
        )));
    }
    let mut salt = [0u8; 16];
    rng.fill_bytes(&mut salt);
    let mut nonce = [0u8; 24];
    rng.fill_bytes(&mut nonce);
    let mut b = Backup {
        version: BACKUP_VERSION,
        kdf: "argon2id".into(),
        m_cost_kib: BACKUP_M_COST_KIB,
        t_cost: BACKUP_T_COST,
        p_cost: BACKUP_P_COST,
        salt: salt.to_vec(),
        nonce: nonce.to_vec(),
        ciphertext: Vec::new(),
    };
    let key = backup_key(passphrase, &b.salt, b.m_cost_kib, b.t_cost, b.p_cost)?;
    let aad = backup_aad(&b);
    let cipher = XChaCha20Poly1305::new((&key).into());
    b.ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| Error::Wallet("backup encryption failed".into()))?;
    Ok(b)
}

pub fn open_backup(passphrase: &str, b: &Backup) -> Result<Vec<u8>> {
    if b.version != BACKUP_VERSION || b.kdf != "argon2id" {
        return Err(Error::Wallet("unsupported backup format".into()));
    }
    if b.nonce.len() != 24 || b.salt.len() < 16 {
        return Err(Error::Wallet("malformed backup".into()));
    }
    // Refuse absurd parameters from a hostile file rather than allocate.
    if b.m_cost_kib > 1024 * 1024 || b.t_cost > 32 || b.p_cost > 8 {
        return Err(Error::Wallet("backup parameters out of range".into()));
    }
    let key = backup_key(passphrase, &b.salt, b.m_cost_kib, b.t_cost, b.p_cost)?;
    let aad = backup_aad(b);
    let cipher = XChaCha20Poly1305::new((&key).into());
    cipher
        .decrypt(
            XNonce::from_slice(&b.nonce),
            Payload {
                msg: &b.ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| Error::Wallet("wrong passphrase or corrupted backup".into()))
}

/// Local storage encryption with a random 32-byte storage key: the wallet is
/// re-sealed on every state change, so this must be cheap (no KDF). The
/// storage key itself is wrapped with the passphrase once (`seal_backup` on
/// the key bytes), so unlocking runs argon2id once per session.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Sealed {
    pub version: u8,
    #[serde(with = "hex_vec")]
    pub nonce: Vec<u8>,
    #[serde(with = "hex_vec")]
    pub ciphertext: Vec<u8>,
}

const SEALED_AAD: &[u8] = b"PLKS\x01";

pub fn seal_with_key<R: ark_std::rand::CryptoRng + ark_std::rand::RngCore>(
    key: &[u8; 32],
    plaintext: &[u8],
    rng: &mut R,
) -> Result<Sealed> {
    let mut nonce = [0u8; 24];
    rng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new(key.into());
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: SEALED_AAD,
            },
        )
        .map_err(|_| Error::Wallet("storage encryption failed".into()))?;
    Ok(Sealed {
        version: 1,
        nonce: nonce.to_vec(),
        ciphertext,
    })
}

pub fn open_with_key(key: &[u8; 32], s: &Sealed) -> Result<Vec<u8>> {
    if s.version != 1 || s.nonce.len() != 24 {
        return Err(Error::Wallet("unsupported storage format".into()));
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt(
            XNonce::from_slice(&s.nonce),
            Payload {
                msg: &s.ciphertext,
                aad: SEALED_AAD,
            },
        )
        .map_err(|_| Error::Wallet("wrong storage key or corrupted data".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::namespace_id;

    #[test]
    fn receipt_envelope_roundtrip_and_binding() {
        let mut rng = crate::os_rng();
        let ns = namespace_id("a");
        let bob = EncryptionKey::generate(&mut rng);
        let env = seal_receipt(ns, bob.public(), b"opening", &mut rng).unwrap();
        assert_eq!(open_receipt(&bob, &ns, &env).unwrap(), b"opening");
        let eve = EncryptionKey::generate(&mut rng);
        assert!(open_receipt(&eve, &ns, &env).is_err());
        assert_eq!(
            open_receipt(&bob, &namespace_id("b"), &env),
            Err(Error::WrongNamespace)
        );
        let mut t = env.clone();
        t.ciphertext[0] ^= 1;
        assert!(open_receipt(&bob, &ns, &t).is_err());
        let mut t = env.clone();
        t.namespace = namespace_id("b");
        assert!(
            open_receipt(&bob, &namespace_id("b"), &t).is_err(),
            "aad binds the namespace"
        );
    }

    #[test]
    fn storage_key_roundtrip() {
        let mut rng = crate::os_rng();
        let key = [9u8; 32];
        let s = seal_with_key(&key, b"wallet", &mut rng).unwrap();
        assert_eq!(open_with_key(&key, &s).unwrap(), b"wallet");
        assert!(open_with_key(&[8u8; 32], &s).is_err());
    }

    #[test]
    fn backup_roundtrip() {
        let mut rng = crate::os_rng();
        let b = seal_backup("correct horse battery", b"{\"wallet\":1}", &mut rng).unwrap();
        assert_eq!(
            open_backup("correct horse battery", &b).unwrap(),
            b"{\"wallet\":1}"
        );
        assert!(open_backup("wrong horse battery!", &b).is_err());
        assert!(seal_backup("short", b"x", &mut rng).is_err());
        let json = serde_json::to_string(&b).unwrap();
        let back: Backup = serde_json::from_str(&json).unwrap();
        assert_eq!(
            open_backup("correct horse battery", &back).unwrap(),
            b"{\"wallet\":1}"
        );
    }
}
