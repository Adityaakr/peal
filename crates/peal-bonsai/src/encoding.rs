//! Canonical wire encodings.
//!
//! Every byte that crosses a trust boundary is decoded here, strictly: a field
//! element must be the canonical little-endian encoding of an integer below
//! the modulus, and a proof's group elements must decode as points on the
//! curve and in the prime-order subgroup (arkworks' `Validate::Yes`). Anything
//! else is rejected before a pairing is computed, so a malformed submission
//! costs the ledger a few hundred nanoseconds rather than a millisecond.

use ark_ff::{BigInteger, PrimeField};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};
use zkpari::Proof;

use crate::{Error, Fr, Result, E};

/// A canonical 32-byte little-endian field element.
pub const FR_BYTES: usize = 32;
/// A ZK-Pari proof: `2 G1 + 1 F`, compressed.
pub const PROOF_BYTES: usize = 128;

pub fn fr_to_bytes(x: &Fr) -> [u8; FR_BYTES] {
    let mut out = [0u8; FR_BYTES];
    out.copy_from_slice(&x.into_bigint().to_bytes_le());
    out
}

/// Strict decode: rejects encodings at or above the modulus, so every value
/// has exactly one accepted byte string.
pub fn fr_from_bytes(bytes: &[u8]) -> Result<Fr> {
    if bytes.len() != FR_BYTES {
        return Err(Error::Wire(format!(
            "field element must be {FR_BYTES} bytes, got {}",
            bytes.len()
        )));
    }
    let repr = <Fr as PrimeField>::BigInt::from_bits_le(&bytes_to_bits_le(bytes));
    Fr::from_bigint(repr).ok_or(Error::NonCanonicalField)
}

fn bytes_to_bits_le(bytes: &[u8]) -> Vec<bool> {
    bytes
        .iter()
        .flat_map(|b| (0..8).map(move |i| (b >> i) & 1 == 1))
        .collect()
}

pub fn fr_to_hex(x: &Fr) -> String {
    hex::encode(fr_to_bytes(x))
}

pub fn fr_from_hex(s: &str) -> Result<Fr> {
    let bytes = hex::decode(s).map_err(|e| Error::Wire(format!("bad hex: {e}")))?;
    fr_from_bytes(&bytes)
}

pub fn proof_to_bytes(proof: &Proof<E>) -> Vec<u8> {
    let mut out = Vec::with_capacity(PROOF_BYTES);
    proof
        .serialize_with_mode(&mut out, Compress::Yes)
        .expect("in-memory serialization cannot fail");
    debug_assert_eq!(out.len(), PROOF_BYTES);
    out
}

/// Strict decode with curve and subgroup validation.
pub fn proof_from_bytes(bytes: &[u8]) -> Result<Proof<E>> {
    if bytes.len() != PROOF_BYTES {
        return Err(Error::Wire(format!(
            "proof must be {PROOF_BYTES} bytes, got {}",
            bytes.len()
        )));
    }
    Proof::<E>::deserialize_with_mode(bytes, Compress::Yes, Validate::Yes)
        .map_err(|_| Error::InvalidPoint)
}

/// serde helpers: field elements travel as canonical hex.
pub mod fr_hex {
    use super::*;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(x: &Fr, s: S) -> std::result::Result<S::Ok, S::Error> {
        fr_to_hex(x).serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Fr, D::Error> {
        let s = String::deserialize(d)?;
        fr_from_hex(&s).map_err(serde::de::Error::custom)
    }
}

/// serde helpers for `Vec<Fr>`.
pub mod fr_hex_vec {
    use super::*;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(xs: &[Fr], s: S) -> std::result::Result<S::Ok, S::Error> {
        xs.iter().map(fr_to_hex).collect::<Vec<_>>().serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Vec<Fr>, D::Error> {
        let v = Vec::<String>::deserialize(d)?;
        v.iter()
            .map(|s| fr_from_hex(s).map_err(serde::de::Error::custom))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_ff::UniformRand;

    #[test]
    fn field_roundtrip_and_noncanonical_rejected() {
        let mut rng = crate::os_rng();
        for _ in 0..16 {
            let x = Fr::rand(&mut rng);
            assert_eq!(fr_from_bytes(&fr_to_bytes(&x)).unwrap(), x);
        }
        // modulus itself, little-endian: not canonical.
        let modulus = <Fr as PrimeField>::MODULUS.to_bytes_le();
        assert_eq!(fr_from_bytes(&modulus), Err(Error::NonCanonicalField));
        // all-ones: above the modulus.
        assert_eq!(fr_from_bytes(&[0xff; 32]), Err(Error::NonCanonicalField));
        assert!(matches!(fr_from_bytes(&[0u8; 31]), Err(Error::Wire(_))));
    }

    #[test]
    fn proof_decoding_rejects_garbage_and_wrong_length() {
        assert!(matches!(proof_from_bytes(&[0u8; 127]), Err(Error::Wire(_))));
        // 128 bytes of 0xff is not a valid compressed G1 pair.
        assert_eq!(proof_from_bytes(&[0xffu8; 128]), Err(Error::InvalidPoint));
    }
}
