//! Encrypted-at-rest operator keystore: argon2id KDF + ChaCha20-Poly1305.
//!
//! File format: JSON with base64 fields. The plaintext is the OperatorSecret
//! BTE_WIRE_V0 bytes. Secrets never touch logs; this module has no Debug
//! impls over key material.

use anyhow::{bail, Context, Result};
use argon2::Argon2;
use base64::Engine;
use bte_crypto::OperatorSecret;
use chacha20poly1305::aead::Aead;
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce};
use serde::{Deserialize, Serialize};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Serialize, Deserialize)]
pub struct KeystoreFile {
    pub version: u32,
    pub kdf: String,
    pub salt_b64: String,
    pub nonce_b64: String,
    pub ciphertext_b64: String,
    /// 1-based operator index, duplicated in the clear for ops ergonomics.
    pub operator_id: u16,
}

fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32]> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| anyhow::anyhow!("argon2 kdf failed: {e}"))?;
    Ok(key)
}

pub fn seal_keystore(secret: &OperatorSecret, passphrase: &str) -> Result<KeystoreFile> {
    use bte_crypto::rand::Rng;
    let mut rng = bte_crypto::os_rng();
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    rng.fill(&mut salt);
    rng.fill(&mut nonce);

    let key = derive_key(passphrase, &salt)?;
    let cipher = ChaCha20Poly1305::new((&key).into());
    let ciphertext = cipher
        .encrypt(
            &Nonce::try_from(&nonce[..]).expect("12-byte nonce"),
            secret.to_bytes().as_slice(),
        )
        .map_err(|_| anyhow::anyhow!("keystore encryption failed"))?;

    Ok(KeystoreFile {
        version: 1,
        kdf: "argon2id".into(),
        salt_b64: B64.encode(salt),
        nonce_b64: B64.encode(nonce),
        ciphertext_b64: B64.encode(ciphertext),
        operator_id: secret.party_index,
    })
}

pub fn open_keystore(file: &KeystoreFile, passphrase: &str) -> Result<OperatorSecret> {
    if file.version != 1 || file.kdf != "argon2id" {
        bail!("unsupported keystore version/kdf");
    }
    let salt = B64.decode(&file.salt_b64).context("bad salt encoding")?;
    let nonce = B64.decode(&file.nonce_b64).context("bad nonce encoding")?;
    if nonce.len() != 12 {
        bail!("keystore nonce must be 12 bytes");
    }
    let ct = B64
        .decode(&file.ciphertext_b64)
        .context("bad ciphertext encoding")?;
    let key = derive_key(passphrase, &salt)?;
    let cipher = ChaCha20Poly1305::new((&key).into());
    let plaintext = cipher
        .decrypt(
            &Nonce::try_from(nonce.as_slice()).expect("12-byte nonce"),
            ct.as_slice(),
        )
        .map_err(|_| anyhow::anyhow!("keystore decryption failed (wrong passphrase?)"))?;
    let secret = OperatorSecret::from_bytes(&plaintext)
        .map_err(|e| anyhow::anyhow!("keystore payload invalid: {e}"))?;
    if secret.party_index != file.operator_id {
        bail!("keystore operator_id does not match sealed secret");
    }
    Ok(secret)
}

pub fn write_keystore(path: &std::path::Path, file: &KeystoreFile) -> Result<()> {
    std::fs::write(path, serde_json::to_vec_pretty(file)?)?;
    Ok(())
}

pub fn read_keystore(path: &std::path::Path) -> Result<KeystoreFile> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    Ok(serde_json::from_slice(&bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bte_crypto::ceremony;
    use bte_crypto::rand::SeedableRng;

    #[test]
    fn roundtrip_and_wrong_passphrase() {
        let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(1);
        let (_, secrets) = ceremony(3, 2, 4, &mut rng).unwrap();
        let ks = seal_keystore(&secrets[0], "correct horse").unwrap();
        let opened = open_keystore(&ks, "correct horse").unwrap();
        assert_eq!(opened.party_index, secrets[0].party_index);
        assert_eq!(opened.to_bytes(), secrets[0].to_bytes());
        assert!(open_keystore(&ks, "wrong").is_err());
    }
}
