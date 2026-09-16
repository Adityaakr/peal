//! The deposit and withdrawal watcher: one task per enabled namespace.
//!
//! What "credited" means here, exactly: a `Deposit` event emitted by the
//! configured gateway on the configured chain, for the configured token,
//! at least `confirmations` blocks below the chain head, whose block hash
//! still matches when it is processed, and whose receipt has a registered
//! intent. Credit is a ledger mint deduplicated by `chain:tx:logIndex`, so
//! re-processing after a restart or a rewind is harmless.
//!
//! Reorgs: the cursor stores the hash of the last processed block. On every
//! tick that hash is re-read; if it changed, the cursor rewinds by
//! `confirmations` blocks and the range is re-scanned. A deposit that was
//! credited and then reorged away would have been credited from a block
//! deeper than the confirmation policy, which is the accepted risk of that
//! policy and is stated in THREAT_MODEL.md.
//!
//! The watcher also confirms `Withdrawn` events so a withdrawal's status
//! moves from `certificate_ready` to `confirmed`.

use std::sync::Arc;
use std::time::Duration;

use peal_bonsai::encoding::fr_from_hex;
use rusqlite::{params, OptionalExtension};
use tracing::{info, warn};

use crate::api::{credit_intent, AppState};
use crate::config::NamespaceConfig;
use crate::evm::{decode_deposit, decode_withdrawn, deposit_topic, withdrawn_topic, Rpc};

pub const CURSOR_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS watcher_cursors (
    namespace   TEXT PRIMARY KEY,
    last_block  INTEGER NOT NULL,
    last_hash   TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS observed_deposits (
    namespace  TEXT NOT NULL,
    deposit_id TEXT NOT NULL,
    receipt    TEXT NOT NULL,
    amount     TEXT NOT NULL,
    from_addr  TEXT NOT NULL,
    token      TEXT NOT NULL,
    block      INTEGER NOT NULL,
    status     TEXT NOT NULL,        -- credited | unregistered | wrong_token | wrong_amount
    seen_at    INTEGER NOT NULL,
    PRIMARY KEY (namespace, deposit_id)
);
"#;

/// Result of verifying a namespace's chain configuration against the chain.
#[derive(Debug, Clone)]
pub struct ChainCheck {
    pub chain_id_ok: bool,
    pub gateway_has_code: bool,
    pub token_has_code: bool,
}

pub async fn verify_chain(
    rpc: &Rpc,
    ns: &NamespaceConfig,
) -> Result<ChainCheck, crate::evm::RpcError> {
    let chain_id = rpc.chain_id().await?;
    let gateway_code = rpc.code(&ns.gateway).await?;
    let token_code = rpc.code(&ns.token_address).await?;
    Ok(ChainCheck {
        chain_id_ok: chain_id == ns.chain_id,
        gateway_has_code: !gateway_code.is_empty(),
        token_has_code: !token_code.is_empty(),
    })
}

fn load_cursor(conn: &rusqlite::Connection, ns: &str) -> rusqlite::Result<Option<(u64, String)>> {
    conn.query_row(
        "SELECT last_block, last_hash FROM watcher_cursors WHERE namespace = ?1",
        params![ns],
        |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, String>(1)?)),
    )
    .optional()
}

fn save_cursor(
    conn: &rusqlite::Connection,
    ns: &str,
    block: u64,
    hash: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO watcher_cursors (namespace, last_block, last_hash, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(namespace) DO UPDATE SET last_block = excluded.last_block, last_hash = excluded.last_hash, updated_at = excluded.updated_at",
        params![ns, block as i64, hash, crate::product::now() as i64],
    )?;
    Ok(())
}

/// One polling pass. Returns the number of deposits credited.
pub async fn tick(
    app: &Arc<AppState>,
    ns: &NamespaceConfig,
    rpc: &Rpc,
    start_block: u64,
) -> Result<usize, String> {
    let ns_hex = hex::encode(ns.id());
    let head = rpc.block_number().await.map_err(|e| e.to_string())?;
    let safe = head.saturating_sub(ns.confirmations);
    let (mut from, last_hash) = {
        let conn = app.product.lock().expect("product lock");
        load_cursor(&conn, &ns_hex)
            .map_err(|e| e.to_string())?
            .unwrap_or((start_block.saturating_sub(1), String::new()))
    };
    // Reorg check on the last processed block.
    if !last_hash.is_empty() && from > 0 {
        let current = rpc.block_hash(from).await.map_err(|e| e.to_string())?;
        if current.as_deref() != Some(last_hash.as_str()) {
            let rewind = from.saturating_sub(ns.confirmations.max(1));
            warn!(
                namespace = ns.label,
                from, rewind, "block hash changed under the cursor; rewinding"
            );
            from = rewind;
        }
    }
    if safe <= from {
        return Ok(0);
    }
    // Bounded ranges so a long catch-up cannot time out the RPC.
    let to = (from + 2000).min(safe);
    let logs = rpc
        .logs(&ns.gateway, &deposit_topic(), from + 1, to)
        .await
        .map_err(|e| e.to_string())?;
    let mut credited = 0;
    for log in logs {
        if log.removed {
            continue;
        }
        let ev = match decode_deposit(&log) {
            Ok(ev) => ev,
            Err(e) => {
                warn!(namespace = ns.label, error = %e, "undecodable deposit log");
                continue;
            }
        };
        let deposit_id = ev.deposit_id(ns.chain_id);
        let receipt_le = ev.receipt_hex.clone();
        let status = if ev.token != ns.token_address.to_lowercase() {
            "wrong_token"
        } else if fr_from_hex(&receipt_le).is_err() {
            "bad_receipt"
        } else {
            match credit(app, ns, &receipt_le, &deposit_id, ev.amount).await {
                Ok(true) => {
                    credited += 1;
                    "credited"
                }
                Ok(false) => "unregistered",
                Err(e) if e.contains("wrong_amount") => "wrong_amount",
                Err(e) if e.contains("already") => "credited",
                Err(e) => {
                    warn!(namespace = ns.label, deposit_id, error = %e, "credit failed; will retry");
                    continue;
                }
            }
        };
        let conn = app.product.lock().expect("product lock");
        conn.execute(
            "INSERT INTO observed_deposits (namespace, deposit_id, receipt, amount, from_addr, token, block, status, seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(namespace, deposit_id) DO UPDATE SET status = excluded.status",
            params![ns_hex, deposit_id, receipt_le, ev.amount.to_string(), ev.from, ev.token, ev.block_number as i64, status, crate::product::now() as i64],
        )
        .map_err(|e| e.to_string())?;
        if status != "credited" {
            info!(
                namespace = ns.label,
                deposit_id, status, "deposit observed but not credited"
            );
        }
    }
    // Withdrawals confirmed on chain.
    let wlogs = rpc
        .logs(&ns.gateway, &withdrawn_topic(), from + 1, to)
        .await
        .map_err(|e| e.to_string())?;
    for log in wlogs {
        if let Ok(ev) = decode_withdrawn(&log) {
            let conn = app.product.lock().expect("product lock");
            let n = conn
                .execute(
                    "UPDATE withdrawals SET status = 'confirmed', tx_hash = ?3, confirmed_at = ?4 WHERE namespace = ?1 AND withdrawal_id = ?2 AND status != 'confirmed'",
                    params![ns_hex, ev.withdrawal_id, ev.tx_hash, crate::product::now() as i64],
                )
                .map_err(|e| e.to_string())?;
            if n > 0 {
                info!(
                    namespace = ns.label,
                    withdrawal_id = ev.withdrawal_id,
                    tx = ev.tx_hash,
                    "withdrawal confirmed on chain"
                );
            }
        }
    }
    let hash = rpc
        .block_hash(to)
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let conn = app.product.lock().expect("product lock");
    save_cursor(&conn, &ns_hex, to, &hash).map_err(|e| e.to_string())?;
    Ok(credited)
}

/// Credit a deposit against its registered intent. `Ok(false)` when no
/// intent is registered yet (the deposit stays observed and is credited when
/// the intent arrives, see `credit_unregistered`).
async fn credit(
    app: &Arc<AppState>,
    ns: &NamespaceConfig,
    receipt_le: &str,
    deposit_id: &str,
    amount: u128,
) -> Result<bool, String> {
    let intent_amount: Option<String> = {
        let conn = app.product.lock().expect("product lock");
        conn.query_row(
            "SELECT intent FROM deposit_intents WHERE namespace = ?1 AND receipt = ?2",
            params![hex::encode(ns.id()), receipt_le],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
        .and_then(|v| {
            v.get("amount")
                .and_then(|a| a.as_u64())
                .map(|a| a.to_string())
        })
    };
    let Some(intent_amount) = intent_amount else {
        return Ok(false);
    };
    if intent_amount != amount.to_string() {
        // The chain says one amount, the intent (and its proof) another:
        // never credit either; the depositor must register a matching
        // intent for this receipt, which is impossible, so the deposit is
        // stuck and reported. Recorded as such.
        return Err(format!(
            "wrong_amount: chain {amount}, intent {intent_amount}"
        ));
    }
    let receipt = fr_from_hex(receipt_le).map_err(|e| e.to_string())?;
    match credit_intent(app, ns.id(), receipt, deposit_id.to_string()).await {
        Ok(_) => Ok(true),
        Err(p) if p.code == "already_minted" => Err("already credited".into()),
        Err(p) => Err(p.detail),
    }
}

/// Deposits observed before their intent was registered: credit them once
/// the intent arrives. Called after every intent registration.
pub async fn credit_unregistered(
    app: &Arc<AppState>,
    ns_id: peal_bonsai::account::Namespace,
    receipt_le: &str,
) -> Result<bool, String> {
    let ns = app
        .namespaces
        .get(&ns_id)
        .ok_or("unknown namespace")?
        .clone();
    let row: Option<(String, String)> = {
        let conn = app.product.lock().expect("product lock");
        conn.query_row(
            "SELECT deposit_id, amount FROM observed_deposits WHERE namespace = ?1 AND receipt = ?2 AND status = 'unregistered'",
            params![hex::encode(ns_id), receipt_le],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
    };
    let Some((deposit_id, amount)) = row else {
        return Ok(false);
    };
    let amount: u128 = amount.parse().map_err(|_| "bad amount")?;
    let ok = credit(app, &ns, receipt_le, &deposit_id, amount).await?;
    if ok {
        let conn = app.product.lock().expect("product lock");
        conn.execute(
            "UPDATE observed_deposits SET status = 'credited' WHERE namespace = ?1 AND deposit_id = ?2",
            params![hex::encode(ns_id), deposit_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(ok)
}

/// Run the watcher for one namespace until the process ends.
pub async fn run(app: Arc<AppState>, ns: NamespaceConfig, interval: Duration) {
    let rpc = Rpc::new(&ns.rpc_url);
    // Verify the chain before touching the ledger. A namespace whose chain
    // does not match its configuration is never marked available.
    loop {
        match verify_chain(&rpc, &ns).await {
            Ok(c) if c.chain_id_ok && c.gateway_has_code && c.token_has_code => {
                info!(
                    namespace = ns.label,
                    chain_id = ns.chain_id,
                    gateway = ns.gateway,
                    "chain verified; deposits and withdrawals available"
                );
                app.availability
                    .lock()
                    .expect("availability lock")
                    .insert(ns.id(), true);
                break;
            }
            Ok(c) => {
                warn!(
                    namespace = ns.label,
                    ?c,
                    "chain configuration does not match the chain; namespace stays unavailable"
                );
                app.availability
                    .lock()
                    .expect("availability lock")
                    .insert(ns.id(), false);
            }
            Err(e) => {
                warn!(namespace = ns.label, error = %e, "chain unreachable; namespace stays unavailable");
                app.availability
                    .lock()
                    .expect("availability lock")
                    .insert(ns.id(), false);
            }
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    let start = ns.start_block;
    loop {
        match tick(&app, &ns, &rpc, start).await {
            Ok(n) if n > 0 => info!(namespace = ns.label, credited = n, "deposits credited"),
            Ok(_) => {}
            Err(e) => warn!(namespace = ns.label, error = %e, "watcher tick failed"),
        }
        tokio::time::sleep(interval).await;
    }
}
