//! EIP-712 verification for the `/v1` Private Actions API.
//!
//! This is the server side of `packages/actions/src/sign.ts`. The two must
//! agree byte-for-byte on the digest or every honest agent is rejected, so the
//! tests here pin digests produced by viem rather than by this code.
//!
//! Why the coordinator verifies at all, given the SDK already does: the SDK
//! runs on the agent's machine and an attacker simply would not run it. Without
//! a server-side check, `pseudonymousSigner` is an unauthenticated string and
//! anyone can submit intents attributed to anyone.
//!
//! No curve arithmetic is implemented here. keccak256 comes from `sha3` and
//! ECDSA recovery from `k256`, both RustCrypto.

use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use sha3::{Digest, Keccak256};

/// `EIP712Domain(string name,string version,uint256 chainId)`
///
/// Three fields, not five: `sign.ts` omits `verifyingContract` and `salt`, and
/// viem hashes only the fields actually present in the domain object. Adding a
/// field here that the SDK does not send changes the separator and breaks every
/// signature.
const DOMAIN_TYPE: &[u8] = b"EIP712Domain(string name,string version,uint256 chainId)";
const DOMAIN_NAME: &[u8] = b"Peal Private Actions";
const DOMAIN_VERSION: &[u8] = b"1";

const INTENT_TYPE: &[u8] = b"Intent(uint16 protocolVersion,string intentId,bytes32 encryptionKeyId,bytes32 ciphertextHash,string nonce,uint64 expiresAt,uint256 executionDomain)";

#[derive(Debug, PartialEq, Eq)]
pub enum SigError {
    /// Not 65 bytes of hex, or a recovery id outside {0,1,27,28}.
    Malformed,
    /// s > n/2. Rejected rather than normalised: every valid signer produces
    /// low-s, so a high-s signature is a mutated copy of one. Accepting it
    /// would let a relay alter a stored signature without altering who it
    /// recovers to.
    HighS,
    /// Well-formed, but recovers to somebody other than the claimed signer.
    WrongSigner,
}

fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Keccak256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// A `uint256`/`uint64`/`uint16` in ABI encoding: right-aligned in 32 bytes.
fn word(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

fn domain_separator(chain_id: u64) -> [u8; 32] {
    keccak(&[
        &keccak(&[DOMAIN_TYPE]),
        &keccak(&[DOMAIN_NAME]),
        &keccak(&[DOMAIN_VERSION]),
        &word(chain_id as u128),
    ])
}

/// Decode 32 lowercase hex bytes into a `bytes32` word.
fn bytes32(hex_no_prefix: &str) -> Option<[u8; 32]> {
    let raw = hex::decode(hex_no_prefix).ok()?;
    let arr: [u8; 32] = raw.try_into().ok()?;
    Some(arr)
}

/// The digest an agent signs for an intent envelope.
///
/// Mirrors `intentDigest` in `sign.ts`. `encryption_key_id` and
/// `ciphertext_hash` are `bytes32` so they are embedded raw, while `intent_id`
/// and `nonce` are `string` so they are hashed first — getting that backwards
/// produces a digest that looks plausible and verifies nothing.
#[allow(clippy::too_many_arguments)]
pub fn intent_digest(
    protocol_version: u16,
    intent_id: &str,
    encryption_key_id: &str,
    ciphertext_hash: &str,
    nonce: &str,
    expires_at: i64,
    execution_domain: u64,
) -> Option<[u8; 32]> {
    if expires_at < 0 {
        return None;
    }
    let struct_hash = keccak(&[
        &keccak(&[INTENT_TYPE]),
        &word(protocol_version as u128),
        &keccak(&[intent_id.as_bytes()]),
        &bytes32(encryption_key_id)?,
        &bytes32(ciphertext_hash)?,
        &keccak(&[nonce.as_bytes()]),
        &word(expires_at as u128),
        &word(execution_domain as u128),
    ]);
    Some(keccak(&[
        b"\x19\x01",
        &domain_separator(execution_domain),
        &struct_hash,
    ]))
}

/// Recover the signing address from a 65-byte `r || s || v` signature over an
/// already-computed digest.
///
/// Returns a lowercase `0x`-prefixed address. Recovery always succeeds for a
/// well-formed signature over any digest, so a bare recovery authenticates
/// nothing on its own — compare the result against a claimed signer.
pub fn recover(digest: &[u8; 32], sig_hex: &str) -> Result<String, SigError> {
    let body = sig_hex.strip_prefix("0x").unwrap_or(sig_hex);
    let raw = hex::decode(body).map_err(|_| SigError::Malformed)?;
    if raw.len() != 65 {
        return Err(SigError::Malformed);
    }

    let sig = Signature::from_slice(&raw[..64]).map_err(|_| SigError::Malformed)?;
    if sig.normalize_s().is_some() {
        return Err(SigError::HighS);
    }

    // Wallets emit v as 27/28; raw signers sometimes emit 0/1. Both are the
    // same recovery bit.
    let v = match raw[64] {
        0 | 27 => 0u8,
        1 | 28 => 1u8,
        _ => return Err(SigError::Malformed),
    };
    let rec = RecoveryId::from_byte(v).ok_or(SigError::Malformed)?;

    let vk =
        VerifyingKey::recover_from_prehash(digest, &sig, rec).map_err(|_| SigError::Malformed)?;

    // Address = last 20 bytes of keccak256(uncompressed pubkey minus its 0x04
    // SEC1 tag).
    let point = vk.to_encoded_point(false);
    let hash = keccak(&[&point.as_bytes()[1..]]);
    Ok(format!("0x{}", hex::encode(&hash[12..])))
}

/// Recover and compare against a claimed signer, case-insensitively.
pub fn verify(digest: &[u8; 32], sig_hex: &str, claimed: &str) -> Result<(), SigError> {
    let got = recover(digest, sig_hex)?;
    if got == claimed.to_lowercase() {
        Ok(())
    } else {
        Err(SigError::WrongSigner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Produced by viem via `packages/actions/src/sign.ts`'s exact domain and
    // types. Pinned rather than recomputed so that a change to either side of
    // the wire shows up as a failing test instead of as agents being silently
    // rejected in production. The key is a throwaway 0x22..22 test key.
    const DIGEST: &str = "ac039d74344b84f7dc88be984299c64d0f2719042910195e2143fe90788dace6";
    const SIGNER: &str = "0x1563915e194d8cfba1943570603f7606a3115508";
    const SIG: &str = "0xaf16f42f10606d7bc19a3f987a8adcbbc8a8574c93ee4da46cf583af2e6138d42e75b315c25afe2c4278ade8a7a0eb64b49f4986144eb84965ac871ce26db6241b";

    /// Ethereum Hoodi, the deployment target.
    const CHAIN: u64 = 560_048;
    /// Ethereum mainnet, used only as "a different chain".
    const OTHER_CHAIN: u64 = 1;

    fn vector_digest() -> [u8; 32] {
        intent_digest(
            1,
            "intent-test-0001",
            &"11".repeat(32),
            &"ab".repeat(32),
            "nonce-test-0001",
            1_893_456_000,
            CHAIN,
        )
        .expect("well-formed vector")
    }

    #[test]
    fn digest_matches_viem() {
        assert_eq!(hex::encode(vector_digest()), DIGEST);
    }

    #[test]
    fn recovers_the_viem_signer() {
        assert_eq!(recover(&vector_digest(), SIG).unwrap(), SIGNER);
        assert_eq!(verify(&vector_digest(), SIG, SIGNER), Ok(()));
    }

    #[test]
    fn claimed_signer_is_case_insensitive() {
        let mixed = "0x1563915e194D8CfBA1943570603F7606A3115508";
        assert_eq!(verify(&vector_digest(), SIG, mixed), Ok(()));
    }

    /// The actual attack the server-side check exists to stop: a well-formed
    /// signature by somebody else, submitted under a claimed signer.
    #[test]
    fn rejects_a_signature_from_another_key() {
        let other = "0x000000000000000000000000000000000000dead";
        assert_eq!(
            verify(&vector_digest(), SIG, other),
            Err(SigError::WrongSigner)
        );
    }

    /// Every field is bound: flipping any one of them must move the digest, or
    /// that field is not actually authenticated.
    #[test]
    fn every_field_is_bound_into_the_digest() {
        let base = vector_digest();
        let variants = [
            intent_digest(
                2,
                "intent-test-0001",
                &"11".repeat(32),
                &"ab".repeat(32),
                "nonce-test-0001",
                1_893_456_000,
                CHAIN,
            ),
            intent_digest(
                1,
                "intent-test-0002",
                &"11".repeat(32),
                &"ab".repeat(32),
                "nonce-test-0001",
                1_893_456_000,
                CHAIN,
            ),
            intent_digest(
                1,
                "intent-test-0001",
                &"12".repeat(32),
                &"ab".repeat(32),
                "nonce-test-0001",
                1_893_456_000,
                CHAIN,
            ),
            intent_digest(
                1,
                "intent-test-0001",
                &"11".repeat(32),
                &"ac".repeat(32),
                "nonce-test-0001",
                1_893_456_000,
                CHAIN,
            ),
            intent_digest(
                1,
                "intent-test-0001",
                &"11".repeat(32),
                &"ab".repeat(32),
                "nonce-test-0002",
                1_893_456_000,
                CHAIN,
            ),
            intent_digest(
                1,
                "intent-test-0001",
                &"11".repeat(32),
                &"ab".repeat(32),
                "nonce-test-0001",
                1_893_456_001,
                CHAIN,
            ),
            // executionDomain also moves the domain separator, not just the struct.
            intent_digest(
                1,
                "intent-test-0001",
                &"11".repeat(32),
                &"ab".repeat(32),
                "nonce-test-0001",
                1_893_456_000,
                OTHER_CHAIN,
            ),
        ];
        for (i, v) in variants.iter().enumerate() {
            assert_ne!(v.unwrap(), base, "variant {i} did not change the digest");
        }
    }

    /// A signature valid on Hoodi must not be replayable on Ethereum mainnet.
    #[test]
    fn signature_does_not_replay_across_chains() {
        let other_chain = intent_digest(
            1,
            "intent-test-0001",
            &"11".repeat(32),
            &"ab".repeat(32),
            "nonce-test-0001",
            1_893_456_000,
            OTHER_CHAIN,
        )
        .unwrap();
        assert_eq!(
            verify(&other_chain, SIG, SIGNER),
            Err(SigError::WrongSigner)
        );
    }

    #[test]
    fn rejects_malformed_signatures() {
        let d = vector_digest();
        for bad in ["0x", "0xdeadbeef", "not-hex", &SIG[..SIG.len() - 2]] {
            assert_eq!(recover(&d, bad), Err(SigError::Malformed), "accepted {bad}");
        }
        // A recovery byte outside {0,1,27,28}.
        let mut wrong_v = SIG.to_string();
        wrong_v.truncate(SIG.len() - 2);
        wrong_v.push_str("07");
        assert_eq!(recover(&d, &wrong_v), Err(SigError::Malformed));
    }

    /// s must be low. The malleated twin recovers to a different address, so
    /// accepting it would admit a second valid-looking signature per intent.
    #[test]
    fn rejects_high_s_malleated_signatures() {
        // n, the secp256k1 group order.
        const N: [u8; 32] = [
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c,
            0xd0, 0x36, 0x41, 0x41,
        ];
        let raw = hex::decode(&SIG[2..]).unwrap();
        // s' = n - s, and flip the recovery bit: the standard malleation.
        let mut s = [0u8; 32];
        s.copy_from_slice(&raw[32..64]);
        let mut borrow = 0i16;
        let mut hi = [0u8; 32];
        for i in (0..32).rev() {
            let d = N[i] as i16 - s[i] as i16 - borrow;
            hi[i] = (d.rem_euclid(256)) as u8;
            borrow = if d < 0 { 1 } else { 0 };
        }
        let mut mutated = raw[..32].to_vec();
        mutated.extend_from_slice(&hi);
        mutated.push(if raw[64] == 27 { 28 } else { 27 });

        assert_eq!(
            recover(&vector_digest(), &format!("0x{}", hex::encode(&mutated))),
            Err(SigError::HighS)
        );
    }

    #[test]
    fn rejects_bad_hex_field_lengths() {
        assert!(intent_digest(1, "i", "11", &"ab".repeat(32), "n", 1, 1).is_none());
        assert!(intent_digest(1, "i", &"11".repeat(32), "abcd", "n", 1, 1).is_none());
        assert!(intent_digest(1, "i", &"11".repeat(32), &"ab".repeat(32), "n", -1, 1).is_none());
    }
}
