//! An operator's long-term identity for BTE v1 committees: an ed25519 key
//! (signs DKG envelopes and dealer logs) and an X25519 key (receives sealed
//! private dealings). Encrypted at rest like every keystore here; the
//! public halves are duplicated in the clear so an operator can hand them
//! to whoever starts a round without opening the file.

use crate::keystore::{open_bytes, seal_bytes, Encrypted};
use anyhow::{bail, Context, Result};
use bte_crypto::tbte::dkg::{
    generate_identity, identity_bytes, identity_from_bytes, identity_key_bytes, identity_key_of,
    BoxSecret, Identity, IdentityKey,
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct IdentityFile {
    pub version: u32,
    pub kind: String,
    /// ed25519 public key, hex.
    pub identity: String,
    /// X25519 public key, hex.
    #[serde(rename = "box")]
    pub box_key: String,
    #[serde(flatten)]
    pub encrypted: Encrypted,
}

pub const KIND: &str = "bte-v1-operator-identity";

/// The opened identity.
pub struct OperatorIdentity {
    pub identity: Identity,
    pub box_secret: BoxSecret,
}

impl OperatorIdentity {
    pub fn generate() -> OperatorIdentity {
        let mut rng = bte_crypto::os_rng();
        OperatorIdentity {
            identity: generate_identity(&mut rng),
            box_secret: BoxSecret::generate(&mut rng),
        }
    }

    pub fn key(&self) -> IdentityKey {
        identity_key_of(&self.identity)
    }

    pub fn key_hex(&self) -> String {
        hex::encode(identity_key_bytes(&self.key()))
    }

    pub fn box_hex(&self) -> String {
        hex::encode(self.box_secret.public())
    }

    pub fn seal(&self, passphrase: &str) -> Result<IdentityFile> {
        let mut plain = identity_bytes(&self.identity);
        plain.extend_from_slice(&self.box_secret.to_bytes());
        let encrypted = seal_bytes(&plain, passphrase)?;
        Ok(IdentityFile {
            version: 2,
            kind: KIND.into(),
            identity: self.key_hex(),
            box_key: self.box_hex(),
            encrypted,
        })
    }

    pub fn open(file: &IdentityFile, passphrase: &str) -> Result<OperatorIdentity> {
        if file.version != 2 || file.kind != KIND {
            bail!("not a v1 operator identity file");
        }
        let plain = open_bytes(&file.encrypted, passphrase)?;
        if plain.len() != 64 {
            bail!("identity payload has the wrong length");
        }
        let identity =
            identity_from_bytes(&plain[..32]).map_err(|e| anyhow::anyhow!("identity key: {e}"))?;
        let box_secret = BoxSecret::from_bytes(plain[32..].try_into().unwrap());
        let me = OperatorIdentity {
            identity,
            box_secret,
        };
        if me.key_hex() != file.identity.to_lowercase()
            || me.box_hex() != file.box_key.to_lowercase()
        {
            bail!("identity file public keys do not match the sealed secret");
        }
        Ok(me)
    }
}

pub fn write_identity(path: &std::path::Path, file: &IdentityFile) -> Result<()> {
    std::fs::write(path, serde_json::to_vec_pretty(file)?)?;
    Ok(())
}

pub fn read_identity(path: &std::path::Path) -> Result<IdentityFile> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    Ok(serde_json::from_slice(&bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_wrong_passphrase() {
        let me = OperatorIdentity::generate();
        let file = me.seal("pass").unwrap();
        let back = OperatorIdentity::open(&file, "pass").unwrap();
        assert_eq!(back.key_hex(), me.key_hex());
        assert_eq!(back.box_hex(), me.box_hex());
        assert!(OperatorIdentity::open(&file, "nope").is_err());
        let mut tampered = me.seal("pass").unwrap();
        tampered.identity = back.box_hex();
        assert!(OperatorIdentity::open(&tampered, "pass").is_err());
    }
}
