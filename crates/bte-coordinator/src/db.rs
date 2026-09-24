//! Sqlite persistence. Schema per spec/index.md section 7.

use anyhow::Result;
use rusqlite::Connection;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS committees (
    id            TEXT PRIMARY KEY,          -- hex params digest
    params_blob   BLOB NOT NULL,
    params_digest TEXT NOT NULL,
    n             INTEGER NOT NULL,
    t             INTEGER NOT NULL,
    b             INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conditions (
    id           TEXT PRIMARY KEY,
    committee_id TEXT NOT NULL REFERENCES committees(id),
    kind         TEXT NOT NULL,              -- at_time | at_block
    fires_at     INTEGER,                    -- unix seconds (at_time)
    chain_id     INTEGER,                    -- at_block
    height       INTEGER,                    -- at_block
    status       TEXT NOT NULL DEFAULT 'pending',  -- pending|frozen|revealed|stalled
    tag          TEXT,                       -- optional client label (round:bid, capsule, ...)
    -- Public presentation, shown before anything opens: what this round is for.
    -- Never secret, unlike the payloads sealed to it.
    title        TEXT,
    description  TEXT,
    image_url    TEXT,
    created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ciphertexts (
    ct_hash      TEXT PRIMARY KEY,
    condition_id TEXT NOT NULL REFERENCES conditions(id),
    sealed_blob  BLOB NOT NULL,
    is_dummy     INTEGER NOT NULL DEFAULT 0,
    position     INTEGER,                    -- global position, set at freeze
    created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cts_condition ON ciphertexts(condition_id);
CREATE TABLE IF NOT EXISTS batches (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    condition_id  TEXT NOT NULL REFERENCES conditions(id),
    batch_index   INTEGER NOT NULL,          -- 0-based within the condition
    frozen_at     INTEGER NOT NULL,
    finalized_at  INTEGER,
    predecrypt_ms INTEGER,
    finalize_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_batches_condition ON batches(condition_id);
CREATE TABLE IF NOT EXISTS shares (
    batch_id     INTEGER NOT NULL REFERENCES batches(id),
    operator_id  INTEGER NOT NULL,
    share_blob   BLOB NOT NULL,
    verified     INTEGER NOT NULL,
    submitted_at INTEGER NOT NULL,
    PRIMARY KEY (batch_id, operator_id)
);
CREATE TABLE IF NOT EXISTS batch_slots (
    batch_id   INTEGER PRIMARY KEY REFERENCES batches(id),
    slots_json TEXT NOT NULL
);
-- Counted events that leave no other trace: a skill file fetched, a paid call
-- settled. One row per kind per day, so the table stays small no matter how
-- much traffic there is, and nothing about a visitor is stored: not an address,
-- not an agent string, not a request. Only that a thing happened, and when.
CREATE TABLE IF NOT EXISTS counters (
    kind  TEXT NOT NULL,
    day   TEXT NOT NULL,            -- YYYY-MM-DD, UTC
    count INTEGER NOT NULL,
    PRIMARY KEY (kind, day)
);

-- Payments redeemed by the x402 gateway. The hash is the primary key because
-- redemption IS the insert: a transaction that has bought a call cannot buy a
-- second one, and two requests racing on the same hash cannot both win.
CREATE TABLE IF NOT EXISTS x402_payments (
    tx_hash     TEXT PRIMARY KEY,
    payer       TEXT NOT NULL,
    amount      TEXT NOT NULL,
    redeemed_at INTEGER NOT NULL
);

-- Retry safety for POST /v1/rounds. Keyed by the caller's Idempotency-Key so a
-- timed-out create returns the original round instead of making a second one.
CREATE TABLE IF NOT EXISTS idempotency (
    key           TEXT PRIMARY KEY,
    round_id      TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    -- A fingerprint of the request the key was first used with. Reusing a key
    -- with a different body is a mistake, not a retry, and returning the
    -- original round for it hands back the wrong resource with a 200.
    request_hash  TEXT
);
-- Auction rules for a round: what a bid means and what can win. The bids
-- themselves are ordinary ciphertexts and are not here.
CREATE TABLE IF NOT EXISTS auctions (
    condition_id       TEXT PRIMARY KEY REFERENCES conditions(id),
    currency           TEXT NOT NULL,
    decimals           INTEGER NOT NULL,
    reserve_minor      INTEGER,
    maximum_minor      INTEGER,
    -- The seller's PUBLIC half only. The private key never reaches this server;
    -- if it did, we could read every contact detail bidders sealed to it.
    contact_public_key TEXT
);
CREATE TABLE IF NOT EXISTS reveals (
    condition_id  TEXT PRIMARY KEY REFERENCES conditions(id),
    revealed_at   INTEGER NOT NULL,
    payloads_blob TEXT NOT NULL,             -- JSON slot array
    merkle_root   TEXT NOT NULL
);
"#;

pub fn open(path: &str) -> Result<Connection> {
    let conn = if path == ":memory:" {
        Connection::open_in_memory()?
    } else {
        Connection::open(path)?
    };
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.pragma_update(None, "busy_timeout", 5000)?;
    conn.execute_batch(SCHEMA)?;
    // Migration for databases created before the fingerprint existed. Rows
    // without one are treated as matching anything, so keys already in flight
    // when this shipped keep working rather than starting to 422.
    let _ = conn.execute("ALTER TABLE idempotency ADD COLUMN request_hash TEXT", []);

    // Migration for databases created before the tag column existed.
    conn.execute("ALTER TABLE conditions ADD COLUMN tag TEXT", [])
        .ok();
    // Migration for databases created before a round could describe itself.
    for column in ["title TEXT", "description TEXT", "image_url TEXT"] {
        conn.execute(&format!("ALTER TABLE conditions ADD COLUMN {column}"), [])
            .ok();
    }
    // Migration for databases created before short share codes existed. Rows
    // predating this keep code NULL; their long-form share links still resolve
    // without the code, so there is nothing to backfill.
    conn.execute("ALTER TABLE ciphertexts ADD COLUMN code TEXT", [])
        .ok();
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_cts_code ON ciphertexts(code) WHERE code IS NOT NULL;",
    )?;
    // BTE v1 (transparent setup from a DKG). A committee names its scheme;
    // rows from before the column existed are v0. A v1 ciphertext's KEM
    // point is unique per condition, so a sealer cannot enter the same
    // randomness twice and make the batch's admission check fail for
    // everyone.
    conn.execute(
        "ALTER TABLE committees ADD COLUMN scheme TEXT NOT NULL DEFAULT 'v0'",
        [],
    )
    .ok();
    conn.execute("ALTER TABLE ciphertexts ADD COLUMN kem_point TEXT", [])
        .ok();
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_cts_kem_point
           ON ciphertexts(condition_id, kem_point) WHERE kem_point IS NOT NULL;",
    )?;
    // Private Actions (/v1). Additive: new tables only, so a devnet database
    // created before intents existed opens unchanged.
    conn.execute_batch(crate::intents::SCHEMA)?;
    // The DKG relay (BTE v1 committees). Additive tables.
    conn.execute_batch(crate::dkg::SCHEMA)?;
    Ok(conn)
}

/// Parse DATABASE_URL: `sqlite://path` or a bare path.
pub fn path_from_url(url: &str) -> String {
    url.strip_prefix("sqlite://").unwrap_or(url).to_string()
}

pub fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock before 1970")
        .as_secs() as i64
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock before 1970")
        .as_millis() as i64
}
