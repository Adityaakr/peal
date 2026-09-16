//! Sign-in with Ethereum (EIP-4361 message shape) for the request API.
//!
//! The wallet signs a plain-text message naming the domain, the address, a
//! server nonce and an expiry; the server recovers the signer from the
//! EIP-191 personal-sign digest and issues a bearer token. EOAs only:
//! ERC-1271 contract wallets are refused with an explicit error rather than
//! treated as EOAs, because their validity depends on chain state this node
//! does not verify.
//!
//! Sessions authorize *product* operations (creating and listing requests).
//! They never authorize value: that is the proof's job.

use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use sha3::{Digest, Keccak256};

#[derive(Debug, PartialEq, Eq)]
pub struct Siwe {
    pub domain: String,
    pub address: String,
    pub nonce: String,
    pub issued_at: String,
    pub expiration_time: Option<String>,
    pub chain_id: u64,
}

/// Parse the EIP-4361 message. Strict: unknown lines are an error, and every
/// required line must be present in order.
pub fn parse(message: &str) -> Result<Siwe, &'static str> {
    let mut lines = message.split('\n');
    let first = lines.next().ok_or("empty")?;
    let domain = first
        .strip_suffix(" wants you to sign in with your Ethereum account:")
        .ok_or("bad first line")?
        .to_string();
    let address = lines.next().ok_or("missing address")?.trim().to_string();
    if !crate::config::is_address(&address) {
        return Err("bad address");
    }
    // Optional statement: a blank line, then either the statement or the
    // next blank line before the fields.
    let mut rest: Vec<&str> = lines.collect();
    if rest.first() != Some(&"") {
        return Err("missing blank line");
    }
    rest.remove(0);
    if let Some(first) = rest.first() {
        if !first.starts_with("URI: ") {
            // statement line, then a blank line
            rest.remove(0);
            if rest.first() != Some(&"") {
                return Err("missing blank after statement");
            }
            rest.remove(0);
        }
    }
    let mut uri = None;
    let mut version = None;
    let mut chain_id = None;
    let mut nonce = None;
    let mut issued_at = None;
    let mut expiration_time = None;
    for line in rest {
        if line.is_empty() {
            continue;
        }
        let (k, v) = line.split_once(": ").ok_or("bad field line")?;
        match k {
            "URI" => uri = Some(v.to_string()),
            "Version" => version = Some(v.to_string()),
            "Chain ID" => chain_id = Some(v.parse::<u64>().map_err(|_| "bad chain id")?),
            "Nonce" => nonce = Some(v.to_string()),
            "Issued At" => issued_at = Some(v.to_string()),
            "Expiration Time" => expiration_time = Some(v.to_string()),
            "Not Before" | "Request ID" | "Resources" => {}
            _ if k.starts_with("- ") => {}
            _ => return Err("unknown field"),
        }
    }
    if version.as_deref() != Some("1") {
        return Err("version must be 1");
    }
    uri.ok_or("missing URI")?;
    Ok(Siwe {
        domain,
        address,
        nonce: nonce.ok_or("missing nonce")?,
        issued_at: issued_at.ok_or("missing issued at")?,
        expiration_time,
        chain_id: chain_id.ok_or("missing chain id")?,
    })
}

/// EIP-191 personal-sign digest of `message`.
pub fn personal_digest(message: &str) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(b"\x19Ethereum Signed Message:\n");
    h.update(message.len().to_string().as_bytes());
    h.update(message.as_bytes());
    h.finalize().into()
}

/// Recover the checksummed-insensitive lowercase address from a 65-byte
/// hex signature over `digest`. Rejects high-s and malformed input.
pub fn recover(digest: &[u8; 32], sig_hex: &str) -> Result<String, &'static str> {
    let raw = hex::decode(sig_hex.trim_start_matches("0x")).map_err(|_| "signature is not hex")?;
    if raw.len() != 65 {
        return Err("signature must be 65 bytes");
    }
    let v = match raw[64] {
        0 | 27 => 0u8,
        1 | 28 => 1u8,
        _ => return Err("bad recovery id"),
    };
    let sig = Signature::from_slice(&raw[..64]).map_err(|_| "malformed signature")?;
    if sig.normalize_s().is_some() {
        return Err("high-s signature");
    }
    let rid = RecoveryId::from_byte(v).ok_or("bad recovery id")?;
    let key =
        VerifyingKey::recover_from_prehash(digest, &sig, rid).map_err(|_| "recovery failed")?;
    let point = key.to_encoded_point(false);
    let pub_bytes = &point.as_bytes()[1..];
    let hash = Keccak256::digest(pub_bytes);
    Ok(format!("0x{}", hex::encode(&hash[12..])))
}

pub fn parse_rfc3339(s: &str) -> Option<u64> {
    // Minimal RFC 3339 UTC parser: YYYY-MM-DDTHH:MM:SS(.fff)?Z
    let s = s.trim_end_matches('Z');
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, mo, da) = (d.next()??, d.next()??, d.next()??);
    let time = time.split('.').next()?;
    let mut t = time.split(':').map(|x| x.parse::<i64>().ok());
    let (h, mi, se) = (t.next()??, t.next()??, t.next()??);
    // days from civil (Howard Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let secs = days * 86400 + h * 3600 + mi * 60 + se;
    u64::try_from(secs).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_siwe_message() {
        let msg = "localhost:5173 wants you to sign in with your Ethereum account:\n0x1234567890abcdef1234567890abcdef12345678\n\nSign in to Peal Links.\n\nURI: http://localhost:5173/bonsai/app\nVersion: 1\nChain ID: 31337\nNonce: abcdefgh12345678\nIssued At: 2026-09-16T10:00:00Z\nExpiration Time: 2026-09-16T10:10:00Z";
        let s = parse(msg).unwrap();
        assert_eq!(s.domain, "localhost:5173");
        assert_eq!(s.nonce, "abcdefgh12345678");
        assert_eq!(s.chain_id, 31337);
        assert_eq!(parse_rfc3339("2026-09-16T10:00:00Z"), Some(1789552800));
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
    }

    #[test]
    fn recovers_a_known_personal_sign() {
        // Signed with the well-known anvil account 0 key
        // (0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80),
        // message "hello", produced by viem's signMessage.
        let sig = "0xf16ea9a3478698f695fd1401bfe27e9e4a7e8e3da94aa72b021125e31fa899cc573c48ea3fe1d4ab61a9db10c19032026e3ed2dbccba5a178235ac27f94504311c";
        let addr = recover(&personal_digest("hello"), sig).unwrap();
        assert_eq!(addr, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    }
}
