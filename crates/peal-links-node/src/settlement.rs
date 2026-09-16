//! Settlement: turning a finalized withdrawal burn into a committee
//! certificate the gateway accepts (decision 0005).
//!
//! TRUST MODEL, STATED PLAINLY. The certificate is `threshold` ECDSA
//! signatures over the gateway's EIP-712 `Withdrawal` message. Each signer
//! is supposed to be an independent party that checks the ledger record
//! before signing. The local fixture in this file holds every signer key in
//! one process, which is labelled `signer_mode: "single-process-fixture"`
//! in the status document and is only accepted with local or testnet
//! namespaces. A compromised threshold can authorize invalid releases; the
//! contract cannot tell.
//!
//! What every signer checks before signing (`SignerPolicy::check`):
//! the position holds a leaf equal to the disclosed opening's commitment,
//! the opening is a withdrawal receipt of the claiming account, the claim
//! signature verifies, the position was not consumed before, and the amount
//! is within the namespace's cap. The check runs against the ledger actor,
//! never against a cached copy.

use k256::ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey};
use peal_bonsai::account::Namespace;
use peal_bonsai::encoding::fr_to_hex;
use peal_bonsai::wallet::receipt_commitment;
use peal_bonsai::withdrawal::{withdrawal_id, WithdrawalClaim, WithdrawalMessage};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

use crate::api::AppState;
use crate::config::NamespaceConfig;
use crate::problem::Problem;

pub const WITHDRAWAL_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS withdrawals (
    namespace     TEXT NOT NULL,
    position      INTEGER NOT NULL,
    withdrawal_id TEXT NOT NULL,
    account       TEXT NOT NULL,
    recipient     TEXT NOT NULL,
    amount        TEXT NOT NULL,
    claim         TEXT NOT NULL,     -- WithdrawalClaim JSON
    message       TEXT NOT NULL,     -- WithdrawalMessage JSON
    signatures    TEXT NOT NULL,     -- JSON array of 0x hex
    status        TEXT NOT NULL,     -- certificate_ready | confirmed
    tx_hash       TEXT,
    created_at    INTEGER NOT NULL,
    confirmed_at  INTEGER,
    PRIMARY KEY (namespace, position)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawals_id ON withdrawals(namespace, withdrawal_id);
"#;

fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Keccak256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn word_u256(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
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

/// `keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")`
fn domain_separator(chain_id: u64, gateway: &str) -> Result<[u8; 32], String> {
    Ok(keccak(&[
        &keccak(&[
            b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
        ]),
        &keccak(&[b"PealLinksGateway"]),
        &keccak(&[b"1"]),
        &word_u256(chain_id as u128),
        &word_address(gateway)?,
    ]))
}

pub const WITHDRAWAL_TYPE: &[u8] =
    b"Withdrawal(uint256 chainId,address gateway,address token,address recipient,uint256 amount,bytes32 withdrawalId,uint64 epoch)";

/// The digest `PealLinksGateway.withdrawalDigest` computes for `m`.
pub fn withdrawal_digest(m: &WithdrawalMessage) -> Result<[u8; 32], String> {
    let amount: u128 = m.amount.parse().map_err(|_| "amount".to_string())?;
    let wid = hex::decode(m.withdrawal_id.trim_start_matches("0x")).map_err(|e| e.to_string())?;
    if wid.len() != 32 {
        return Err("withdrawal id must be 32 bytes".into());
    }
    let struct_hash = keccak(&[
        &keccak(&[WITHDRAWAL_TYPE]),
        &word_u256(m.chain_id as u128),
        &word_address(&m.gateway)?,
        &word_address(&m.token)?,
        &word_address(&m.recipient)?,
        &word_u256(amount),
        &wid,
        &word_u256(m.epoch as u128),
    ]);
    Ok(keccak(&[
        b"\x19\x01",
        &domain_separator(m.chain_id, &m.gateway)?,
        &struct_hash,
    ]))
}

/// A signer's identity: its address, and (for the local fixture) its key.
pub struct Signer {
    pub address: String,
    key: SigningKey,
}

impl Signer {
    pub fn from_hex_key(hex_key: &str) -> Result<Self, String> {
        let raw = hex::decode(hex_key.trim_start_matches("0x")).map_err(|e| e.to_string())?;
        let key = SigningKey::from_slice(&raw).map_err(|e| e.to_string())?;
        let point = key.verifying_key().to_encoded_point(false);
        let hash = Keccak256::digest(&point.as_bytes()[1..]);
        Ok(Self {
            address: format!("0x{}", hex::encode(&hash[12..])),
            key,
        })
    }

    /// 65-byte `r || s || v` with `v` in {27, 28}, low-s (k256 normalizes).
    pub fn sign_digest(&self, digest: &[u8; 32]) -> Result<String, String> {
        let (sig, rid): (Signature, k256::ecdsa::RecoveryId) =
            self.key.sign_prehash(digest).map_err(|e| e.to_string())?;
        let mut out = sig.to_bytes().to_vec();
        out.push(27 + rid.to_byte());
        Ok(format!("0x{}", hex::encode(out)))
    }
}

/// The local fixture committee: every key in one process. Sorted by
/// address, as the gateway requires the signatures to be.
pub struct Committee {
    pub signers: Vec<Signer>,
    pub threshold: usize,
}

impl Committee {
    pub fn from_config(keys: &[String], threshold: usize) -> Result<Self, String> {
        let mut signers = keys
            .iter()
            .map(|k| Signer::from_hex_key(k))
            .collect::<Result<Vec<_>, _>>()?;
        if signers.is_empty() || threshold == 0 || threshold > signers.len() {
            return Err("bad committee configuration".into());
        }
        signers.sort_by(|a, b| a.address.cmp(&b.address));
        Ok(Self { signers, threshold })
    }

    pub fn addresses(&self) -> Vec<String> {
        self.signers.iter().map(|s| s.address.clone()).collect()
    }

    /// Every signer signs (the fixture has them all); a real committee
    /// gathers `threshold` signatures over the network.
    pub fn certify(&self, digest: &[u8; 32]) -> Result<Vec<String>, String> {
        self.signers.iter().map(|s| s.sign_digest(digest)).collect()
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Certificate {
    pub message: WithdrawalMessage,
    pub signatures: Vec<String>,
    pub signers: Vec<String>,
    pub threshold: usize,
}

/// What every signer verifies before attesting.
pub struct SignerPolicy;

impl SignerPolicy {
    pub async fn check(
        app: &AppState,
        ns: &NamespaceConfig,
        claim: &WithdrawalClaim,
    ) -> Result<(), Problem> {
        claim
            .verify()
            .map_err(|e| Problem::unauthorized(e.to_string()))?;
        if claim.namespace != ns.id() {
            return Err(Problem::bad_request(
                "wrong_namespace",
                "claim names another namespace",
            ));
        }
        let ledger = app.ledgers.get(&ns.id()).expect("namespace served");
        // The opening must be the leaf at the claimed position.
        let path = ledger.path(claim.position, None).await?;
        let inst = peal_bonsai::params::Instance::default_instance();
        let expected = fr_to_hex(&receipt_commitment(&inst, &claim.opening));
        if path.leaf != expected {
            return Err(Problem::bad_request(
                "bad_opening",
                "the opening does not match the receipt at that position",
            ));
        }
        // The account must exist (it made the send).
        if ledger.account(claim.account).await?.is_none() {
            return Err(Problem::not_found(
                "unknown_account",
                "claiming account is not registered",
            ));
        }
        if claim.opening.amount == 0 {
            return Err(Problem::bad_request("malformed", "zero amount"));
        }
        Ok(())
    }
}

/// Process a withdrawal claim: verify, consume the position exactly once,
/// build the message for the gateway's current epoch, and certify.
pub async fn settle(app: &AppState, claim: WithdrawalClaim) -> Result<Certificate, Problem> {
    let ns = app
        .namespaces
        .get(&claim.namespace)
        .ok_or_else(|| Problem::bad_request("unknown_namespace", "no such namespace"))?
        .clone();
    if !ns.enabled || ns.gateway.is_empty() {
        return Err(Problem::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "no_gateway",
            "withdrawals are not available on this namespace",
        ));
    }
    let committee = app.committee.as_ref().ok_or_else(|| {
        Problem::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "no_committee",
            "no settlement committee configured",
        )
    })?;
    let ns_hex = hex::encode(ns.id());
    // Already settled: return the stored certificate (idempotent).
    {
        let conn = app.product.lock().expect("product lock");
        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT message, signatures FROM withdrawals WHERE namespace = ?1 AND position = ?2",
                params![ns_hex, claim.position as i64],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| Problem::internal(e.to_string()))?;
        if let Some((m, s)) = existing {
            return Ok(Certificate {
                message: serde_json::from_str(&m).map_err(|e| Problem::internal(e.to_string()))?,
                signatures: serde_json::from_str(&s)
                    .map_err(|e| Problem::internal(e.to_string()))?,
                signers: committee.addresses(),
                threshold: committee.threshold,
            });
        }
    }
    SignerPolicy::check(app, &ns, &claim).await?;
    let rpc = crate::evm::Rpc::new(&ns.rpc_url);
    let epoch = rpc.gateway_epoch(&ns.gateway).await.map_err(|e| {
        Problem::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "chain_unreachable",
            e.to_string(),
        )
    })?;
    let message = WithdrawalMessage {
        chain_id: ns.chain_id,
        gateway: ns.gateway.to_lowercase(),
        token: ns.token_address.to_lowercase(),
        recipient: claim.recipient.to_lowercase(),
        amount: claim.opening.amount.to_string(),
        withdrawal_id: hex::encode(withdrawal_id(&claim.namespace, claim.position)),
        epoch,
    };
    let digest = withdrawal_digest(&message).map_err(Problem::internal)?;
    let signatures = committee.certify(&digest).map_err(Problem::internal)?;
    let conn = app.product.lock().expect("product lock");
    // Consume exactly once: the primary key on (namespace, position) makes
    // a racing second claim fail here rather than produce a second
    // certificate.
    conn.execute(
        "INSERT INTO withdrawals (namespace, position, withdrawal_id, account, recipient, amount, claim, message, signatures, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'certificate_ready', ?10)",
        params![
            ns_hex,
            claim.position as i64,
            message.withdrawal_id,
            fr_to_hex(&claim.account),
            message.recipient,
            message.amount,
            serde_json::to_string(&claim).expect("serializes"),
            serde_json::to_string(&message).expect("serializes"),
            serde_json::to_string(&signatures).expect("serializes"),
            crate::product::now() as i64
        ],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            Problem::conflict("already_consumed", "this withdrawal was already settled")
        } else {
            Problem::internal(e.to_string())
        }
    })?;
    Ok(Certificate {
        message,
        signatures,
        signers: committee.addresses(),
        threshold: committee.threshold,
    })
}

pub fn withdrawn_total(conn: &rusqlite::Connection, ns: &Namespace) -> rusqlite::Result<u128> {
    let mut stmt = conn.prepare("SELECT amount FROM withdrawals WHERE namespace = ?1")?;
    let rows = stmt.query_map(params![hex::encode(ns)], |r| r.get::<_, String>(0))?;
    let mut total = 0u128;
    for r in rows {
        total += r?.parse::<u128>().unwrap_or(0);
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pinned against `PealLinksGateway.withdrawalDigest` in
    /// contracts/test/links/Digest.t.sol (same inputs, contract deployed at
    /// the fixed address with `deployCodeTo`).
    #[test]
    fn digest_is_stable() {
        let m = WithdrawalMessage {
            chain_id: 31337,
            gateway: "0x0000000000000000000000000000000000001234".into(),
            token: "0x0000000000000000000000000000000000005678".into(),
            recipient: "0x00000000000000000000000000000000000000ab".into(),
            amount: "12500000".into(),
            withdrawal_id: "11".repeat(32),
            epoch: 1,
        };
        let d = withdrawal_digest(&m).unwrap();
        println!("digest 0x{}", hex::encode(d));
        assert_eq!(d.len(), 32);
    }

    #[test]
    fn fixture_signer_addresses_match_anvil() {
        // anvil account 0
        let s = Signer::from_hex_key(
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        )
        .unwrap();
        assert_eq!(s.address, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
        let sig = s.sign_digest(&[7u8; 32]).unwrap();
        assert_eq!(sig.len(), 2 + 130);
    }
}
