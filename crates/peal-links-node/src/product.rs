//! Product storage: sessions, payment requests, inbox, deposit intents.
//! Separate sqlite file from every ledger, so presentation data and ledger
//! state never share a transaction or a backup.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS nonces (
    nonce      TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    address    TEXT NOT NULL,
    chain_id   INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_address ON sessions(address);
CREATE TABLE IF NOT EXISTS requests (
    request_id    TEXT PRIMARY KEY,
    namespace     TEXT NOT NULL,
    owner_address TEXT NOT NULL,
    receiver      TEXT NOT NULL,
    manifest      TEXT NOT NULL,     -- JSON, as signed
    status        TEXT NOT NULL,     -- active | archived | fulfilled
    fulfilled_at  INTEGER,
    ack           TEXT,              -- receiver-signed FulfillmentAck JSON
    reserved_by   TEXT,              -- payer intent id (soft lock)
    reserved_until INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_owner ON requests(owner_address, created_at DESC);
CREATE TABLE IF NOT EXISTS inbox_keys (
    namespace TEXT NOT NULL,
    account   TEXT NOT NULL,
    binding   TEXT NOT NULL,         -- KeyBinding JSON
    seq       INTEGER NOT NULL,
    PRIMARY KEY (namespace, account)
);
CREATE TABLE IF NOT EXISTS inbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace  TEXT NOT NULL,
    account    TEXT NOT NULL,
    envelope   TEXT NOT NULL,        -- ReceiptEnvelope JSON
    request_id TEXT,
    posted_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_account ON inbox(namespace, account, id);
CREATE TABLE IF NOT EXISTS deposit_intents (
    namespace  TEXT NOT NULL,
    receipt    TEXT NOT NULL,
    intent     TEXT NOT NULL,        -- DepositIntent JSON
    status     TEXT NOT NULL,        -- pending | minted
    deposit_id TEXT,
    position   INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, receipt)
);
"#;

pub fn open(path: &std::path::Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
    )?;
    conn.execute_batch(SCHEMA)?;
    conn.execute_batch(crate::watcher::CURSOR_SCHEMA)?;
    conn.execute_batch(crate::settlement::WITHDRAWAL_SCHEMA)?;
    conn.execute_batch(crate::directory::SCHEMA)?;
    Ok(conn)
}

pub fn open_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(SCHEMA)?;
    conn.execute_batch(crate::watcher::CURSOR_SCHEMA)?;
    conn.execute_batch(crate::settlement::WITHDRAWAL_SCHEMA)?;
    conn.execute_batch(crate::directory::SCHEMA)?;
    Ok(conn)
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn random_token(bytes: usize) -> String {
    let mut rng = peal_bonsai::os_rng();
    let mut buf = vec![0u8; bytes];
    peal_bonsai::rand::RngCore::fill_bytes(&mut rng, &mut buf);
    hex::encode(buf)
}

pub struct Session {
    pub address: String,
    pub chain_id: u64,
}

pub fn session(conn: &Connection, token: &str) -> Result<Option<Session>> {
    let now = now() as i64;
    Ok(conn
        .query_row(
            "SELECT address, chain_id FROM sessions WHERE token = ?1 AND expires_at > ?2",
            params![token, now],
            |r| {
                Ok(Session {
                    address: r.get(0)?,
                    chain_id: r.get::<_, i64>(1)? as u64,
                })
            },
        )
        .optional()?)
}

pub fn issue_nonce(conn: &Connection, ttl: u64) -> Result<(String, u64)> {
    let nonce = random_token(16);
    let expires = now() + ttl;
    conn.execute(
        "INSERT INTO nonces (nonce, expires_at) VALUES (?1, ?2)",
        params![nonce, expires as i64],
    )?;
    // Housekeeping: expired nonces go.
    conn.execute(
        "DELETE FROM nonces WHERE expires_at < ?1",
        params![now() as i64],
    )?;
    Ok((nonce, expires))
}

/// Consume a nonce exactly once. Returns false if unknown, expired or used.
pub fn consume_nonce(conn: &Connection, nonce: &str) -> Result<bool> {
    let n = conn.execute(
        "UPDATE nonces SET used = 1 WHERE nonce = ?1 AND used = 0 AND expires_at > ?2",
        params![nonce, now() as i64],
    )?;
    Ok(n == 1)
}

pub fn create_session(
    conn: &Connection,
    address: &str,
    chain_id: u64,
    ttl: u64,
) -> Result<(String, u64)> {
    let token = random_token(32);
    let now = now();
    let expires = now + ttl;
    conn.execute(
        "INSERT INTO sessions (token, address, chain_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![token, address, chain_id as i64, now as i64, expires as i64],
    )?;
    Ok((token, expires))
}
