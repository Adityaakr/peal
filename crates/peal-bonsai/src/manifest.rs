//! Payment request manifests: what a receiver signs and a payer verifies.
//!
//! A request binds a receiving account, its receipt-encryption key, an exact
//! amount and an asset domain. The receiver's spend key signs the canonical
//! bytes; the payer checks the signature *and* that the signing key is the one
//! `receiver_account` derives from on that namespace, so neither the request
//! API nor anyone on the path can redirect funds or swap the encryption key.
//! Editing any critical field is a new manifest with a new signature.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::account::{account_id, hex_32, hex_64, Namespace, SpendKey};
use crate::encoding::{fr_hex, fr_to_bytes};
use crate::{Error, Fr, Result};

pub const MANIFEST_MAGIC: &[u8; 4] = b"PLKM";
/// Version 2 (one-wallet addendum, decision 0011) names the receiver's
/// wallet address so a checkout can show it and verify, through the
/// directory, that the signing key is the one that wallet authorized.
pub const MANIFEST_VERSION: u8 = 2;
pub const MAX_TITLE: usize = 140;
pub const MAX_DISPLAY_NAME: usize = 60;
pub const MAX_REFERENCE: usize = 64;

/// Request ids: 24 characters of lowercase base32 (120 bits).
pub fn is_request_id(s: &str) -> bool {
    s.len() == 24 && s.bytes().all(|b| matches!(b, b'a'..=b'z' | b'2'..=b'7'))
}

/// A lowercase `0x` + 40 hex digit EVM address.
pub fn is_evm_address(s: &str) -> bool {
    s.len() == 42
        && s.starts_with("0x")
        && s[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn new_request_id<R: ark_std::rand::RngCore>(rng: &mut R) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut bytes = [0u8; 15];
    rng.fill_bytes(&mut bytes);
    // 15 bytes = 120 bits = 24 base32 characters.
    let mut out = String::with_capacity(24);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for b in bytes {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((acc >> bits) & 31) as usize] as char);
        }
    }
    out
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RequestManifest {
    pub version: u8,
    pub request_id: String,
    #[serde(with = "hex_32")]
    pub namespace: Namespace,
    #[serde(with = "fr_hex")]
    pub receiver_account: Fr,
    /// x25519 public key the payer encrypts the receipt opening to.
    #[serde(with = "hex_32")]
    pub receiver_enc_key: [u8; 32],
    /// Base units. Serialized as a decimal string on the wire.
    #[serde(with = "u64_string")]
    pub amount: u64,
    pub title: String,
    pub display_name: String,
    /// The receiver's 0x wallet address, lowercase (version 2).
    pub receiver_address: String,
    pub reference: Option<String>,
    pub expires_at: Option<u64>,
    pub created_at: u64,
    #[serde(with = "hex_32")]
    pub signer_pubkey: [u8; 32],
    #[serde(with = "hex_64")]
    pub signature: [u8; 64],
}

pub mod u64_string {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn serialize<S: Serializer>(x: &u64, s: S) -> std::result::Result<S::Ok, S::Error> {
        x.to_string().serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u64, D::Error> {
        let s = String::deserialize(d)?;
        if s.is_empty() || s.len() > 20 || !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(serde::de::Error::custom(
                "amount must be a decimal integer string",
            ));
        }
        s.parse::<u64>().map_err(serde::de::Error::custom)
    }
}

fn push_str(m: &mut Vec<u8>, s: &str) {
    m.extend_from_slice(&(s.len() as u32).to_le_bytes());
    m.extend_from_slice(s.as_bytes());
}

impl RequestManifest {
    /// Canonical bytes: fixed order, length-prefixed strings, no JSON.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut m = Vec::with_capacity(256);
        m.extend_from_slice(MANIFEST_MAGIC);
        m.push(self.version);
        push_str(&mut m, &self.request_id);
        m.extend_from_slice(&self.namespace);
        m.extend_from_slice(&fr_to_bytes(&self.receiver_account));
        m.extend_from_slice(&self.receiver_enc_key);
        m.extend_from_slice(&self.amount.to_le_bytes());
        push_str(&mut m, &self.title);
        push_str(&mut m, &self.display_name);
        push_str(&mut m, &self.receiver_address);
        match &self.reference {
            Some(r) => {
                m.push(1);
                push_str(&mut m, r);
            }
            None => m.push(0),
        }
        match self.expires_at {
            Some(t) => {
                m.push(1);
                m.extend_from_slice(&t.to_le_bytes());
            }
            None => m.push(0),
        }
        m.extend_from_slice(&self.created_at.to_le_bytes());
        m.extend_from_slice(&self.signer_pubkey);
        m
    }

    /// Field-level validation that needs no key: lengths, id shape, times.
    pub fn validate_fields(&self) -> Result<()> {
        if self.version != MANIFEST_VERSION {
            return Err(Error::Wire("unsupported manifest version".into()));
        }
        if !is_request_id(&self.request_id) {
            return Err(Error::Wire("bad request id".into()));
        }
        if self.title.trim().is_empty() || self.title.chars().count() > MAX_TITLE {
            return Err(Error::Wire("title must be 1 to 140 characters".into()));
        }
        if self.display_name.trim().is_empty()
            || self.display_name.chars().count() > MAX_DISPLAY_NAME
        {
            return Err(Error::Wire(
                "display name must be 1 to 60 characters".into(),
            ));
        }
        if let Some(r) = &self.reference {
            if r.chars().count() > MAX_REFERENCE {
                return Err(Error::Wire("reference too long".into()));
            }
        }
        if !is_evm_address(&self.receiver_address) {
            return Err(Error::Wire(
                "receiver address must be a lowercase 0x address".into(),
            ));
        }
        if self.amount == 0 {
            return Err(Error::Wire("amount must be positive".into()));
        }
        if let Some(exp) = self.expires_at {
            if exp <= self.created_at {
                return Err(Error::Wire("expiry must be after creation".into()));
            }
        }
        Ok(())
    }

    /// Signature valid and the signer is `receiver_account`'s key on this
    /// namespace. This is what a payer runs before paying.
    pub fn verify(&self) -> Result<()> {
        self.validate_fields()?;
        let pk = VerifyingKey::from_bytes(&self.signer_pubkey).map_err(|_| Error::BadSignature)?;
        if account_id(&self.namespace, &pk) != self.receiver_account {
            return Err(Error::BadSignature);
        }
        pk.verify(
            &self.signing_bytes(),
            &Signature::from_bytes(&self.signature),
        )
        .map_err(|_| Error::BadSignature)
    }

    /// Build and sign a manifest for `key`'s account on `namespace`.
    #[allow(clippy::too_many_arguments)]
    pub fn sign(
        key: &SpendKey,
        namespace: Namespace,
        receiver_enc_key: [u8; 32],
        request_id: String,
        amount: u64,
        title: String,
        display_name: String,
        receiver_address: String,
        reference: Option<String>,
        expires_at: Option<u64>,
        created_at: u64,
    ) -> Result<Self> {
        let mut m = Self {
            version: MANIFEST_VERSION,
            request_id,
            namespace,
            receiver_account: key.account_id(&namespace),
            receiver_enc_key,
            amount,
            title,
            display_name,
            receiver_address: receiver_address.to_lowercase(),
            reference,
            expires_at,
            created_at,
            signer_pubkey: key.public().to_bytes(),
            signature: [0u8; 64],
        };
        m.validate_fields()?;
        m.signature = key.sign(&m.signing_bytes());
        Ok(m)
    }
}

/// A receiver's optional, signed acknowledgement that a payment for a
/// request was claimed. Disclosed by the receiver to the request API so the
/// payer's checkout can show "acknowledged"; never derived by the server.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FulfillmentAck {
    pub request_id: String,
    #[serde(with = "hex_32")]
    pub namespace: Namespace,
    #[serde(with = "fr_hex")]
    pub receiver_account: Fr,
    /// Receipt position that was claimed.
    pub position: u64,
    pub claimed_at: u64,
    #[serde(with = "hex_32")]
    pub signer_pubkey: [u8; 32],
    #[serde(with = "hex_64")]
    pub signature: [u8; 64],
}

impl FulfillmentAck {
    fn signing_bytes(&self) -> Vec<u8> {
        let mut m = Vec::with_capacity(160);
        m.extend_from_slice(b"PLKA");
        m.push(1);
        push_str(&mut m, &self.request_id);
        m.extend_from_slice(&self.namespace);
        m.extend_from_slice(&fr_to_bytes(&self.receiver_account));
        m.extend_from_slice(&self.position.to_le_bytes());
        m.extend_from_slice(&self.claimed_at.to_le_bytes());
        m.extend_from_slice(&self.signer_pubkey);
        m
    }

    pub fn sign(
        key: &SpendKey,
        namespace: Namespace,
        request_id: String,
        position: u64,
        claimed_at: u64,
    ) -> Self {
        let mut a = Self {
            request_id,
            namespace,
            receiver_account: key.account_id(&namespace),
            position,
            claimed_at,
            signer_pubkey: key.public().to_bytes(),
            signature: [0u8; 64],
        };
        a.signature = key.sign(&a.signing_bytes());
        a
    }

    pub fn verify(&self) -> Result<()> {
        let pk = VerifyingKey::from_bytes(&self.signer_pubkey).map_err(|_| Error::BadSignature)?;
        if account_id(&self.namespace, &pk) != self.receiver_account {
            return Err(Error::BadSignature);
        }
        pk.verify(
            &self.signing_bytes(),
            &Signature::from_bytes(&self.signature),
        )
        .map_err(|_| Error::BadSignature)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::namespace_id;

    #[test]
    fn manifest_roundtrip_and_tamper() {
        let mut rng = crate::os_rng();
        let key = SpendKey::generate(&mut rng);
        let ns = namespace_id("test");
        let id = new_request_id(&mut rng);
        assert!(is_request_id(&id));
        let m = RequestManifest::sign(
            &key,
            ns,
            [7u8; 32],
            id,
            1_000,
            "Invoice".into(),
            "Mara".into(),
            "0x70997970c51812dc3a010c7d01b50e0d17dc79c8".into(),
            Some("INV-1".into()),
            None,
            100,
        )
        .unwrap();
        m.verify().unwrap();
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"amount\":\"1000\""));
        let back: RequestManifest = serde_json::from_str(&json).unwrap();
        back.verify().unwrap();
        let mut t = m.clone();
        t.amount = 1_001;
        assert_eq!(t.verify(), Err(Error::BadSignature));
        let mut t = m.clone();
        t.receiver_enc_key = [8u8; 32];
        assert_eq!(t.verify(), Err(Error::BadSignature));
        // A different key cannot sign for this account.
        let other = SpendKey::generate(&mut rng);
        let mut t = m.clone();
        t.signer_pubkey = other.public().to_bytes();
        t.signature = other.sign(&t.signing_bytes());
        assert_eq!(t.verify(), Err(Error::BadSignature));
        let ack = FulfillmentAck::sign(&key, ns, m.request_id.clone(), 5, 200);
        ack.verify().unwrap();
    }
}
