//! The directory (decision 0013): signed receiving profiles that resolve a
//! wallet address to the private-account receiving details the wallet
//! authorized (decision 0011), and the backup store (decision 0012).
//!
//! A profile is EIP-712 typed data signed by the wallet. The node verifies
//! it before storing (an EOA by recovery; a contract wallet through
//! ERC-1271 `isValidSignature` on the namespace's chain) so garbage never
//! enters the log, but every client verifies again and never trusts a
//! directory-asserted key. The log per address is append-only and hash
//! chained; a lower version or a wrong `prev` is refused.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

use crate::evm::Rpc;

pub const PROFILE_VERSION_MIN: u64 = 1;
pub const MAX_DISPLAY_NAME: usize = 60;
pub const MAX_BACKUP_BYTES: usize = 1024 * 1024;
pub const BACKUP_VERSIONS_KEPT: usize = 8;

/// `PealLinksAccount` typed data. The field order and types are the
/// EIP-712 type string below; the SDK (`packages/links/src/typed.ts`)
/// carries the same definition, and the node's signature check is what
/// keeps the two in step: a mismatch recovers the wrong address.
pub const PROFILE_TYPE: &str = "PealLinksAccount(uint64 version,address wallet,uint256 chainId,bytes32 namespace,bytes32 account,bytes32 encKey,bytes32 profileKey,string displayName,string recovery,bytes32 nonce,uint64 issuedAt,uint64 expiry,bytes32 prev,bool revoked)";
pub const DOMAIN_TYPE: &str = "EIP712Domain(string name,string version,uint256 chainId)";
pub const DOMAIN_NAME: &str = "Peal Links";
pub const DOMAIN_VERSION: &str = "1";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Profile {
    pub version: u64,
    /// Lowercase 0x address.
    pub wallet: String,
    pub chain_id: u64,
    /// Hex, 32 bytes: the ledger namespace.
    pub namespace: String,
    /// Hex, 32 bytes: the Bonsai account id (canonical field encoding).
    pub account: String,
    /// Hex, 32 bytes: x25519 receiving key.
    pub enc_key: String,
    /// Hex, 32 bytes: ed25519 key that signs manifests and key bindings.
    pub profile_key: String,
    pub display_name: String,
    /// `wallet-signature` or `recovery-code` (decision 0012).
    pub recovery: String,
    /// Hex, 32 bytes.
    pub nonce: String,
    pub issued_at: u64,
    pub expiry: u64,
    /// Hex, 32 bytes: digest of the previous version, or zero.
    pub prev: String,
    pub revoked: bool,
    /// 0x-prefixed 65-byte signature.
    pub signature: String,
}

fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Keccak256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn word_u64(v: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&v.to_be_bytes());
    w
}

fn hex32(s: &str) -> Result<[u8; 32], String> {
    let raw = hex::decode(s.trim_start_matches("0x")).map_err(|e| e.to_string())?;
    if raw.len() != 32 {
        return Err("expected 32 bytes".into());
    }
    let mut w = [0u8; 32];
    w.copy_from_slice(&raw);
    Ok(w)
}

fn word_address(addr: &str) -> Result<[u8; 32], String> {
    let raw = hex::decode(addr.trim_start_matches("0x")).map_err(|e| e.to_string())?;
    if raw.len() != 20 {
        return Err("address must be 20 bytes".into());
    }
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(&raw);
    Ok(w)
}

pub fn domain_separator(chain_id: u64) -> [u8; 32] {
    keccak(&[
        &keccak(&[DOMAIN_TYPE.as_bytes()]),
        &keccak(&[DOMAIN_NAME.as_bytes()]),
        &keccak(&[DOMAIN_VERSION.as_bytes()]),
        &word_u64(chain_id),
    ])
}

impl Profile {
    pub fn validate_fields(&self) -> Result<(), String> {
        if self.version < PROFILE_VERSION_MIN {
            return Err("version must be positive".into());
        }
        if !peal_bonsai::manifest::is_evm_address(&self.wallet) {
            return Err("wallet must be a lowercase 0x address".into());
        }
        for (name, v) in [
            ("namespace", &self.namespace),
            ("account", &self.account),
            ("enc_key", &self.enc_key),
            ("profile_key", &self.profile_key),
            ("nonce", &self.nonce),
            ("prev", &self.prev),
        ] {
            hex32(v).map_err(|e| format!("{name}: {e}"))?;
        }
        if self.display_name.trim().is_empty()
            || self.display_name.chars().count() > MAX_DISPLAY_NAME
        {
            return Err("display name must be 1 to 60 characters".into());
        }
        if !matches!(self.recovery.as_str(), "wallet-signature" | "recovery-code") {
            return Err("recovery must be wallet-signature or recovery-code".into());
        }
        if self.expiry <= self.issued_at {
            return Err("expiry must be after issued_at".into());
        }
        let sig =
            hex::decode(self.signature.trim_start_matches("0x")).map_err(|e| e.to_string())?;
        if sig.len() != 65 {
            return Err("signature must be 65 bytes".into());
        }
        Ok(())
    }

    /// The EIP-712 digest the wallet signed. Also the profile's identity
    /// in the directory log.
    pub fn digest(&self) -> Result<[u8; 32], String> {
        let struct_hash = keccak(&[
            &keccak(&[PROFILE_TYPE.as_bytes()]),
            &word_u64(self.version),
            &word_address(&self.wallet)?,
            &word_u64(self.chain_id),
            &hex32(&self.namespace)?,
            &hex32(&self.account)?,
            &hex32(&self.enc_key)?,
            &hex32(&self.profile_key)?,
            &keccak(&[self.display_name.as_bytes()]),
            &keccak(&[self.recovery.as_bytes()]),
            &hex32(&self.nonce)?,
            &word_u64(self.issued_at),
            &word_u64(self.expiry),
            &hex32(&self.prev)?,
            &word_u64(u64::from(self.revoked)),
        ]);
        Ok(keccak(&[
            b"\x19\x01",
            &domain_separator(self.chain_id),
            &struct_hash,
        ]))
    }
}

/// How a signature was verified.
#[derive(Clone, Debug, Serialize)]
pub struct Verified {
    pub method: &'static str,
    /// Block the ERC-1271 call was made at (contract wallets only).
    pub block: Option<u64>,
}

/// Verify the profile's signature: by recovery for an externally owned
/// account, through ERC-1271 on the named chain for an address with code.
pub async fn verify(profile: &Profile, rpc: Option<&Rpc>) -> Result<Verified, String> {
    profile.validate_fields()?;
    let digest = profile.digest()?;
    if let Ok(addr) = crate::auth::recover(&digest, &profile.signature) {
        if addr.to_lowercase() == profile.wallet {
            return Ok(Verified {
                method: "eoa",
                block: None,
            });
        }
    }
    let Some(rpc) = rpc else {
        return Err("signature does not recover to the wallet address".into());
    };
    let code = rpc.code(&profile.wallet).await.map_err(|e| e.to_string())?;
    if code.is_empty() {
        return Err("signature does not recover to the wallet address".into());
    }
    // ERC-1271: isValidSignature(bytes32,bytes) -> bytes4 0x1626ba7e
    let sig = hex::decode(profile.signature.trim_start_matches("0x")).map_err(|e| e.to_string())?;
    let mut data = Vec::with_capacity(4 + 32 * 4 + 96);
    data.extend_from_slice(&[0x16, 0x26, 0xba, 0x7e]);
    data.extend_from_slice(&digest);
    data.extend_from_slice(&word_u64(0x40));
    data.extend_from_slice(&word_u64(sig.len() as u64));
    data.extend_from_slice(&sig);
    data.resize(4 + 32 * 3 + sig.len().div_ceil(32) * 32, 0);
    let block = rpc.block_number().await.map_err(|e| e.to_string())?;
    let out = rpc
        .eth_call(&profile.wallet, &format!("0x{}", hex::encode(&data)))
        .await
        .map_err(|e| e.to_string())?;
    if out.len() >= 4 && out[..4] == [0x16, 0x26, 0xba, 0x7e] {
        Ok(Verified {
            method: "erc1271",
            block: Some(block),
        })
    } else {
        Err("the contract wallet did not accept the signature".into())
    }
}

// ---- storage -----------------------------------------------------------------

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS directory (
    namespace   TEXT NOT NULL,
    address     TEXT NOT NULL,
    version     INTEGER NOT NULL,
    profile     TEXT NOT NULL,       -- Profile JSON, as signed
    hash        TEXT NOT NULL,       -- EIP-712 digest, hex
    prev        TEXT NOT NULL,
    method      TEXT NOT NULL,       -- eoa | erc1271
    block       INTEGER,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (namespace, address, version)
);
CREATE TABLE IF NOT EXISTS backups (
    namespace  TEXT NOT NULL,
    address    TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    mechanism  TEXT NOT NULL,
    blob       TEXT NOT NULL,        -- ciphertext JSON, opaque here
    created_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, address, seq)
);
"#;

#[derive(Clone, Debug, Serialize)]
pub struct LogEntry {
    pub version: u64,
    pub hash: String,
    pub created_at: u64,
}

pub struct Stored {
    pub profile: Profile,
    pub hash: String,
    pub method: String,
    pub block: Option<u64>,
    pub log: Vec<LogEntry>,
}

pub fn latest(conn: &Connection, ns_hex: &str, address: &str) -> rusqlite::Result<Option<Stored>> {
    let row: Option<(String, String, String, Option<i64>)> = conn
        .query_row(
            "SELECT profile, hash, method, block FROM directory WHERE namespace = ?1 AND address = ?2 ORDER BY version DESC LIMIT 1",
            params![ns_hex, address],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((json, hash, method, block)) = row else {
        return Ok(None);
    };
    let profile: Profile = serde_json::from_str(&json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let mut stmt = conn.prepare(
        "SELECT version, hash, created_at FROM directory WHERE namespace = ?1 AND address = ?2 ORDER BY version ASC",
    )?;
    let log = stmt
        .query_map(params![ns_hex, address], |r| {
            Ok(LogEntry {
                version: r.get::<_, i64>(0)? as u64,
                hash: r.get(1)?,
                created_at: r.get::<_, i64>(2)? as u64,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(Stored {
        profile,
        hash,
        method,
        block: block.map(|b| b as u64),
        log,
    }))
}

/// Append a verified profile. `prev` must equal the latest stored hash (or
/// zero for the first version) and the version must increase.
pub fn append(
    conn: &Connection,
    ns_hex: &str,
    profile: &Profile,
    hash: &str,
    verified: &Verified,
) -> Result<(), String> {
    let current = latest(conn, ns_hex, &profile.wallet).map_err(|e| e.to_string())?;
    match &current {
        Some(c) => {
            if profile.version <= c.profile.version {
                return Err(format!(
                    "version must exceed the published version {}",
                    c.profile.version
                ));
            }
            if profile.prev.trim_start_matches("0x") != c.hash {
                return Err("prev must be the hash of the published version".into());
            }
        }
        None => {
            if profile.prev.trim_start_matches("0x") != "0".repeat(64) {
                return Err("the first version's prev must be zero".into());
            }
        }
    }
    conn.execute(
        "INSERT INTO directory (namespace, address, version, profile, hash, prev, method, block, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            ns_hex,
            profile.wallet,
            profile.version as i64,
            serde_json::to_string(profile).expect("serializes"),
            hash,
            profile.prev.trim_start_matches("0x"),
            verified.method,
            verified.block.map(|b| b as i64),
            crate::product::now() as i64
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BackupUpload {
    pub seq: u64,
    pub mechanism: String,
    pub blob: String,
}

pub fn store_backup(
    conn: &Connection,
    ns_hex: &str,
    address: &str,
    b: &BackupUpload,
) -> Result<(), String> {
    if b.blob.len() > MAX_BACKUP_BYTES {
        return Err("backup too large".into());
    }
    if !matches!(b.mechanism.as_str(), "wallet-signature" | "recovery-code") {
        return Err("unknown recovery mechanism".into());
    }
    let latest: Option<i64> = conn
        .query_row(
            "SELECT MAX(seq) FROM backups WHERE namespace = ?1 AND address = ?2",
            params![ns_hex, address],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    if let Some(l) = latest {
        if (b.seq as i64) < l {
            return Err(format!(
                "a newer backup (state version {l}) is stored; refusing an older one"
            ));
        }
    }
    conn.execute(
        "INSERT OR REPLACE INTO backups (namespace, address, seq, mechanism, blob, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![ns_hex, address, b.seq as i64, b.mechanism, b.blob, crate::product::now() as i64],
    )
    .map_err(|e| e.to_string())?;
    // Keep the last N versions.
    conn.execute(
        "DELETE FROM backups WHERE namespace = ?1 AND address = ?2 AND seq NOT IN (SELECT seq FROM backups WHERE namespace = ?1 AND address = ?2 ORDER BY seq DESC LIMIT ?3)",
        params![ns_hex, address, BACKUP_VERSIONS_KEPT as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn latest_backup(
    conn: &Connection,
    ns_hex: &str,
    address: &str,
) -> rusqlite::Result<Option<(BackupUpload, u64)>> {
    conn.query_row(
        "SELECT seq, mechanism, blob, created_at FROM backups WHERE namespace = ?1 AND address = ?2 ORDER BY seq DESC LIMIT 1",
        params![ns_hex, address],
        |r| {
            Ok((
                BackupUpload {
                    seq: r.get::<_, i64>(0)? as u64,
                    mechanism: r.get(1)?,
                    blob: r.get(2)?,
                },
                r.get::<_, i64>(3)? as u64,
            ))
        },
    )
    .optional()
}

/// A small fixed-window rate limiter keyed by an opaque string (a session
/// token): at most `limit` hits per minute.
#[derive(Default)]
pub struct RateLimiter {
    hits: std::collections::HashMap<String, (u64, u32)>,
}

impl RateLimiter {
    pub fn allow(&mut self, key: &str, limit: u32) -> bool {
        let minute = crate::product::now() / 60;
        if self.hits.len() > 10_000 {
            self.hits.retain(|_, (m, _)| *m == minute);
        }
        let e = self.hits.entry(key.to_string()).or_insert((minute, 0));
        if e.0 != minute {
            *e = (minute, 0);
        }
        e.1 += 1;
        e.1 <= limit
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::{signature::hazmat::PrehashSigner, SigningKey};

    fn sample(wallet: &str) -> Profile {
        Profile {
            version: 1,
            wallet: wallet.to_string(),
            chain_id: 31337,
            namespace: "11".repeat(32),
            account: "22".repeat(32),
            enc_key: "33".repeat(32),
            profile_key: "44".repeat(32),
            display_name: "Alice".into(),
            recovery: "wallet-signature".into(),
            nonce: "55".repeat(32),
            issued_at: 1_700_000_000,
            expiry: 1_800_000_000,
            prev: "0".repeat(64),
            revoked: false,
            signature: "0x".to_string() + &"00".repeat(65),
        }
    }

    fn sign(p: &mut Profile, key: &SigningKey) {
        let digest = p.digest().unwrap();
        let (sig, rid): (k256::ecdsa::Signature, k256::ecdsa::RecoveryId) =
            key.sign_prehash(&digest).unwrap();
        let mut out = sig.to_bytes().to_vec();
        out.push(27 + rid.to_byte());
        p.signature = format!("0x{}", hex::encode(out));
    }

    fn address_of(key: &SigningKey) -> String {
        let point = key.verifying_key().to_encoded_point(false);
        let hash = Keccak256::digest(&point.as_bytes()[1..]);
        format!("0x{}", hex::encode(&hash[12..]))
    }

    #[tokio::test]
    async fn an_eoa_profile_verifies_and_the_log_chains() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let wallet = address_of(&key);
        let mut p = sample(&wallet);
        sign(&mut p, &key);
        let v = verify(&p, None).await.unwrap();
        assert_eq!(v.method, "eoa");
        // A changed field no longer recovers.
        let mut bad = p.clone();
        bad.display_name = "Mallory".into();
        assert!(verify(&bad, None).await.is_err());
        // Log rules.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let ns = "11".repeat(32);
        let hash = hex::encode(p.digest().unwrap());
        append(&conn, &ns, &p, &hash, &v).unwrap();
        let mut p2 = p.clone();
        p2.version = 2;
        p2.prev = "0".repeat(64);
        sign(&mut p2, &key);
        assert!(append(&conn, &ns, &p2, &hex::encode(p2.digest().unwrap()), &v).is_err());
        p2.prev = hash.clone();
        sign(&mut p2, &key);
        append(&conn, &ns, &p2, &hex::encode(p2.digest().unwrap()), &v).unwrap();
        let stored = latest(&conn, &ns, &wallet).unwrap().unwrap();
        assert_eq!(stored.profile.version, 2);
        assert_eq!(stored.log.len(), 2);
        assert_eq!(stored.log[0].hash, hash);
    }

    #[test]
    fn backups_refuse_rollback_and_keep_the_last_versions() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let ns = "11".repeat(32);
        for seq in 1..=10u64 {
            store_backup(
                &conn,
                &ns,
                "0xabc",
                &BackupUpload {
                    seq,
                    mechanism: "recovery-code".into(),
                    blob: format!("{{\"v\":{seq}}}"),
                },
            )
            .unwrap();
        }
        assert!(store_backup(
            &conn,
            &ns,
            "0xabc",
            &BackupUpload {
                seq: 3,
                mechanism: "recovery-code".into(),
                blob: "{}".into()
            }
        )
        .is_err());
        let (latest, _) = latest_backup(&conn, &ns, "0xabc").unwrap().unwrap();
        assert_eq!(latest.seq, 10);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM backups", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count as usize, BACKUP_VERSIONS_KEPT);
    }

    #[test]
    fn rate_limiter_counts_per_minute() {
        let mut r = RateLimiter::default();
        for _ in 0..3 {
            assert!(r.allow("s", 3));
        }
        assert!(!r.allow("s", 3));
        assert!(r.allow("t", 3));
    }
}
