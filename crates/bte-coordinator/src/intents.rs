//! `/v1` — Private Actions intents.
//!
//! This is the server half of `packages/actions`. The lifecycle graph here is a
//! deliberate mirror of `state.ts`: the client tracks its own progress for
//! display, but the client's opinion is never authoritative. An agent that
//! claims `AUTHORIZED` does not become authorized.
//!
//! Two rules run through every handler:
//!
//!  1. **No plaintext before reveal.** An intent's payload lives only inside the
//!     ciphertext until the batch opens. `GET /v1/intents/{id}` returns the
//!     public envelope and the state; there is no code path that can return
//!     payload bytes early, because the coordinator does not have them.
//!
//!  2. **Ordering is committed before shares are collected.** The commitment
//!     row is written at freeze, with a timestamp, and a receipt is only
//!     credible if that timestamp precedes the reveal. Writing it later would
//!     let an executor order a batch it had already read.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::unix_now;
use crate::state::App;

/// Additive migration. Same pattern as the `tag` and `code` columns: new tables
/// only, so an existing devnet database keeps working untouched.
pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS intents (
    id                TEXT PRIMARY KEY,
    protocol_version  INTEGER NOT NULL,
    encryption_key_id TEXT NOT NULL,
    ciphertext_hash   TEXT NOT NULL,
    nonce             TEXT NOT NULL,
    signer            TEXT NOT NULL,
    execution_domain  INTEGER NOT NULL,
    signature         TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    condition_id      TEXT REFERENCES conditions(id),
    state             TEXT NOT NULL,
    -- Set only once the agent has authorized a concrete transaction.
    authorization_hash TEXT,
    authorization_sig  TEXT,
    submission_mode    TEXT,
    -- Returned verbatim to a repeated submission with the same key.
    idempotency_key   TEXT,
    submitted_at      INTEGER NOT NULL
);
-- Replay protection: one nonce per signer, forever. A UNIQUE index rather than
-- a check-then-insert, so two concurrent submissions cannot both pass.
CREATE UNIQUE INDEX IF NOT EXISTS idx_intents_nonce ON intents(signer, nonce);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intents_idem
    ON intents(signer, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intents_condition ON intents(condition_id);
CREATE INDEX IF NOT EXISTS idx_intents_cthash ON intents(ciphertext_hash);

CREATE TABLE IF NOT EXISTS intent_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_id  TEXT NOT NULL REFERENCES intents(id),
    from_state TEXT NOT NULL,
    to_state   TEXT NOT NULL,
    code       TEXT,
    at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_intent ON intent_events(intent_id);

CREATE TABLE IF NOT EXISTS batch_commitments (
    batch_id          INTEGER PRIMARY KEY REFERENCES batches(id),
    condition_id      TEXT NOT NULL REFERENCES conditions(id),
    ordering_root     TEXT NOT NULL,
    batch_size        INTEGER NOT NULL,
    encryption_key_id TEXT NOT NULL,
    committer         TEXT NOT NULL,
    committed_at      INTEGER NOT NULL,
    signature         TEXT
);
"#;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/// Mirrors `STATES` in state.ts. Kept as strings on the wire so both halves
/// speak the same vocabulary and a mismatch is visible rather than silent.
pub const STATES: &[&str] = &[
    "DRAFT",
    "SEALED",
    "SUBMITTED",
    "VALIDATED",
    "BATCHED",
    "ORDER_COMMITTED",
    "COLLECTING_SHARES",
    "THRESHOLD_REACHED",
    "REVEALED",
    "QUOTING",
    "QUOTE_VALIDATED",
    "AUTHORIZATION_REQUIRED",
    "AUTHORIZED",
    "SUBMITTED_FOR_EXECUTION",
    "CONFIRMED",
    "SETTLED",
    "FAILED",
    "EXPIRED",
    "CANCELLED",
];

/// The edge set, identical to state.ts. Duplicated deliberately rather than
/// generated: a generator would be one more thing to trust, and the mirror is
/// asserted by a test that walks both.
pub fn next_states(from: &str) -> &'static [&'static str] {
    match from {
        "DRAFT" => &["SEALED", "CANCELLED"],
        "SEALED" => &["SUBMITTED", "CANCELLED", "EXPIRED"],
        "SUBMITTED" => &["VALIDATED", "FAILED", "CANCELLED", "EXPIRED"],
        "VALIDATED" => &["BATCHED", "FAILED", "CANCELLED", "EXPIRED"],
        "BATCHED" => &["ORDER_COMMITTED", "FAILED", "EXPIRED"],
        "ORDER_COMMITTED" => &["COLLECTING_SHARES", "FAILED"],
        "COLLECTING_SHARES" => &["THRESHOLD_REACHED", "FAILED", "EXPIRED"],
        "THRESHOLD_REACHED" => &["REVEALED", "FAILED"],
        "REVEALED" => &["QUOTING", "FAILED", "EXPIRED", "CANCELLED"],
        "QUOTING" => &["QUOTE_VALIDATED", "FAILED", "EXPIRED", "CANCELLED"],
        "QUOTE_VALIDATED" => &["AUTHORIZATION_REQUIRED", "FAILED", "EXPIRED", "CANCELLED"],
        "AUTHORIZATION_REQUIRED" => &["AUTHORIZED", "CANCELLED", "EXPIRED"],
        "AUTHORIZED" => &["SUBMITTED_FOR_EXECUTION", "CANCELLED", "FAILED", "EXPIRED"],
        "SUBMITTED_FOR_EXECUTION" => &["CONFIRMED", "FAILED"],
        "CONFIRMED" => &["SETTLED", "FAILED"],
        _ => &[],
    }
}

pub fn can_transition(from: &str, to: &str) -> bool {
    next_states(from).contains(&to)
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

type ApiError = (StatusCode, Json<Value>);

/// Stable machine-readable codes. Clients branch on `code`, never on `message`.
fn err(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    (
        status,
        Json(json!({"error": {"code": code, "message": msg.into()}})),
    )
}

fn bad(code: &str, msg: impl Into<String>) -> ApiError {
    err(StatusCode::BAD_REQUEST, code, msg)
}

fn not_found(code: &str, msg: impl Into<String>) -> ApiError {
    err(StatusCode::NOT_FOUND, code, msg)
}

fn conflict(code: &str, msg: impl Into<String>) -> ApiError {
    err(StatusCode::CONFLICT, code, msg)
}

fn internal(e: impl std::fmt::Display) -> ApiError {
    // The error text goes to the log, never to the client: it can carry table
    // names, paths, and occasionally values.
    tracing::error!(error = %e, "v1 internal error");
    err(
        StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL",
        "internal error",
    )
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn is_hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn is_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_url_safe(s: &str, min: usize, max: usize) -> bool {
    s.len() >= min
        && s.len() <= max
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_hex_sig(s: &str) -> bool {
    s.starts_with("0x")
        && s.len() >= 4
        && s.len() <= 1024
        && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

// ---------------------------------------------------------------------------
// POST /v1/intents
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SubmitIntent {
    pub protocol_version: u16,
    pub intent_id: String,
    pub encryption_key_id: String,
    pub ciphertext_hash: String,
    pub nonce: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub pseudonymous_signer: String,
    pub execution_domain: u64,
    pub signature: String,
    /// The condition this intent's ciphertext was submitted under. The
    /// ciphertext itself goes through the existing `/v0/ciphertexts` path, so
    /// this endpoint never handles sealed bytes.
    pub condition_id: String,
    pub idempotency_key: Option<String>,
}

#[derive(Serialize)]
pub struct IntentAccepted {
    pub intent_id: String,
    pub state: String,
    /// True when this call matched a previous submission and changed nothing.
    pub duplicate: bool,
}

async fn submit_intent(
    State(app): State<App>,
    Json(req): Json<SubmitIntent>,
) -> Result<Json<IntentAccepted>, ApiError> {
    let now = unix_now();

    if req.protocol_version != 1 {
        return Err(bad("UNSUPPORTED_VERSION", "protocolVersion must be 1"));
    }
    if !is_url_safe(&req.intent_id, 8, 64) {
        return Err(bad("BAD_INTENT_ID", "intentId must be 8-64 url-safe chars"));
    }
    if !is_url_safe(&req.nonce, 8, 64) {
        return Err(bad("BAD_NONCE", "nonce must be 8-64 url-safe chars"));
    }
    if !is_hex64(&req.ciphertext_hash) {
        return Err(bad(
            "BAD_CIPHERTEXT_HASH",
            "ciphertextHash must be 32 lowercase hex bytes",
        ));
    }
    if !is_hex64(&req.encryption_key_id) {
        return Err(bad(
            "BAD_KEY_ID",
            "encryptionKeyId must be 32 lowercase hex bytes",
        ));
    }
    if !is_address(&req.pseudonymous_signer) {
        return Err(bad("BAD_SIGNER", "pseudonymousSigner must be an address"));
    }
    if !is_hex_sig(&req.signature) {
        return Err(bad("BAD_SIGNATURE", "signature must be hex"));
    }
    if req.execution_domain == 0 {
        return Err(bad("BAD_DOMAIN", "executionDomain must be a chain id"));
    }
    if req.expires_at <= now {
        return Err(bad("EXPIRED", "intent has already expired"));
    }
    // A generous skew allowance, but not unbounded: an intent stamped far in
    // the future would sit valid long past when its agent meant it to.
    if req.created_at > now + 300 {
        return Err(bad("BAD_CREATED_AT", "createdAt is in the future"));
    }

    let signer = req.pseudonymous_signer.to_lowercase();
    let conn = app.0.db.lock().unwrap();

    // Idempotency first: a retried submission must return the original answer
    // rather than colliding with itself on the nonce index.
    if let Some(key) = req.idempotency_key.as_deref() {
        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT id, state FROM intents WHERE signer = ?1 AND idempotency_key = ?2",
                params![signer, key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(internal)?;
        if let Some((id, state)) = existing {
            return Ok(Json(IntentAccepted {
                intent_id: id,
                state,
                duplicate: true,
            }));
        }
    }

    // The ciphertext must already exist under this condition. Accepting an
    // intent that points at nothing would leave a row claiming inclusion in a
    // batch it is not in.
    let ct_ok: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM ciphertexts WHERE ct_hash = ?1 AND condition_id = ?2",
            params![req.ciphertext_hash, req.condition_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(internal)?;
    if ct_ok.is_none() {
        return Err(bad(
            "UNKNOWN_CIPHERTEXT",
            "no ciphertext with that hash under that condition",
        ));
    }

    // An intent may only join a condition that has not frozen. After freeze the
    // ordering is fixed, and attaching to it would claim a position it never had.
    let status: Option<String> = conn
        .query_row(
            "SELECT status FROM conditions WHERE id = ?1",
            params![req.condition_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(internal)?;
    match status.as_deref() {
        None => return Err(not_found("UNKNOWN_CONDITION", "no such condition")),
        Some("pending") => {}
        Some(other) => {
            return Err(conflict(
                "CONDITION_CLOSED",
                format!("condition is {other}; intents can only join a pending condition"),
            ))
        }
    }

    let inserted = conn.execute(
        "INSERT INTO intents (id, protocol_version, encryption_key_id, ciphertext_hash, nonce,
                              signer, execution_domain, signature, created_at, expires_at,
                              condition_id, state, idempotency_key, submitted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'SUBMITTED', ?12, ?13)",
        params![
            req.intent_id,
            req.protocol_version,
            req.encryption_key_id,
            req.ciphertext_hash,
            req.nonce,
            signer,
            req.execution_domain as i64,
            req.signature,
            req.created_at,
            req.expires_at,
            req.condition_id,
            req.idempotency_key,
            now,
        ],
    );

    match inserted {
        Ok(_) => {}
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            // Either the intent id or the (signer, nonce) pair is taken. Both
            // are replays; neither should create a second row.
            return Err(conflict(
                "REPLAY",
                "an intent with this id or nonce already exists for this signer",
            ));
        }
        Err(e) => return Err(internal(e)),
    }

    conn.execute(
        "INSERT INTO intent_events (intent_id, from_state, to_state, at) VALUES (?1, 'SEALED', 'SUBMITTED', ?2)",
        params![req.intent_id, now],
    )
    .map_err(internal)?;

    Ok(Json(IntentAccepted {
        intent_id: req.intent_id,
        state: "SUBMITTED".into(),
        duplicate: false,
    }))
}

// ---------------------------------------------------------------------------
// GET /v1/intents/{id}
// ---------------------------------------------------------------------------

/// One intents row, as served. Named fields rather than a positional tuple:
/// twelve `r.0`-style accessors at the call site is where a wrong column ends
/// up in the wrong JSON key without anything failing to compile.
struct IntentRow {
    id: String,
    protocol_version: i64,
    encryption_key_id: String,
    ciphertext_hash: String,
    nonce: String,
    signer: String,
    execution_domain: i64,
    state: String,
    created_at: i64,
    expires_at: i64,
    condition_id: Option<String>,
    submission_mode: Option<String>,
}

async fn get_intent(
    State(app): State<App>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let conn = app.0.db.lock().unwrap();
    let row: Option<IntentRow> = conn
        .query_row(
            "SELECT id, protocol_version, encryption_key_id, ciphertext_hash, nonce, signer,
                    execution_domain, state, created_at, expires_at, condition_id, submission_mode
             FROM intents WHERE id = ?1",
            params![id],
            |r| {
                Ok(IntentRow {
                    id: r.get(0)?,
                    protocol_version: r.get(1)?,
                    encryption_key_id: r.get(2)?,
                    ciphertext_hash: r.get(3)?,
                    nonce: r.get(4)?,
                    signer: r.get(5)?,
                    execution_domain: r.get(6)?,
                    state: r.get(7)?,
                    created_at: r.get(8)?,
                    expires_at: r.get(9)?,
                    condition_id: r.get(10)?,
                    submission_mode: r.get(11)?,
                })
            },
        )
        .optional()
        .map_err(internal)?;

    let Some(r) = row else {
        return Err(not_found("UNKNOWN_INTENT", "no such intent"));
    };

    // Everything here is public-by-construction: the envelope the agent already
    // published plus the state. There is no branch that returns payload bytes,
    // because the coordinator never holds them outside the ciphertext.
    Ok(Json(json!({
        "intentId": r.id,
        "protocolVersion": r.protocol_version,
        "encryptionKeyId": r.encryption_key_id,
        "ciphertextHash": r.ciphertext_hash,
        "nonce": r.nonce,
        "pseudonymousSigner": r.signer,
        "executionDomain": r.execution_domain,
        "state": r.state,
        "createdAt": r.created_at,
        "expiresAt": r.expires_at,
        "conditionId": r.condition_id,
        "submissionMode": r.submission_mode,
    })))
}

// ---------------------------------------------------------------------------
// GET /v1/intents/{id}/events
// ---------------------------------------------------------------------------

async fn get_intent_events(
    State(app): State<App>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let conn = app.0.db.lock().unwrap();
    let exists: Option<i64> = conn
        .query_row("SELECT 1 FROM intents WHERE id = ?1", params![id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(internal)?;
    if exists.is_none() {
        return Err(not_found("UNKNOWN_INTENT", "no such intent"));
    }

    let mut stmt = conn
        .prepare(
            "SELECT from_state, to_state, code, at FROM intent_events
             WHERE intent_id = ?1 ORDER BY id ASC",
        )
        .map_err(internal)?;
    let rows = stmt
        .query_map(params![id], |r| {
            Ok(json!({
                "from": r.get::<_, String>(0)?,
                "to": r.get::<_, String>(1)?,
                "code": r.get::<_, Option<String>>(2)?,
                "at": r.get::<_, i64>(3)?,
            }))
        })
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;

    Ok(Json(json!({ "intentId": id, "events": rows })))
}

// ---------------------------------------------------------------------------
// GET /v1/batches/{id}/commitment
// ---------------------------------------------------------------------------

struct CommitmentRow {
    condition_id: String,
    ordering_root: String,
    batch_size: i64,
    encryption_key_id: String,
    committer: String,
    committed_at: i64,
    signature: Option<String>,
}

async fn get_batch_commitment(
    State(app): State<App>,
    Path(batch_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let conn = app.0.db.lock().unwrap();
    let row: Option<CommitmentRow> = conn
        .query_row(
            "SELECT condition_id, ordering_root, batch_size, encryption_key_id, committer,
                    committed_at, signature
             FROM batch_commitments WHERE batch_id = ?1",
            params![batch_id],
            |r| {
                Ok(CommitmentRow {
                    condition_id: r.get(0)?,
                    ordering_root: r.get(1)?,
                    batch_size: r.get(2)?,
                    encryption_key_id: r.get(3)?,
                    committer: r.get(4)?,
                    committed_at: r.get(5)?,
                    signature: r.get(6)?,
                })
            },
        )
        .optional()
        .map_err(internal)?;

    let Some(r) = row else {
        // A batch with no commitment is not an error state to paper over: it
        // means ordering was never locked, and a client must not proceed.
        return Err(not_found(
            "NO_COMMITMENT",
            "this batch has no ordering commitment",
        ));
    };

    Ok(Json(json!({
        "batchId": batch_id,
        "conditionId": r.condition_id,
        "orderingRoot": r.ordering_root,
        "batchSize": r.batch_size,
        "encryptionKeyId": r.encryption_key_id,
        "committer": r.committer,
        "committedAt": r.committed_at,
        "signature": r.signature,
    })))
}

// ---------------------------------------------------------------------------
// POST /v1/intents/{id}/authorization
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct PostAuthorization {
    pub authorization_hash: String,
    pub signature: String,
    pub submission_mode: String,
}

async fn post_authorization(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(req): Json<PostAuthorization>,
) -> Result<Json<Value>, ApiError> {
    if !is_hex64(&req.authorization_hash) {
        return Err(bad(
            "BAD_AUTH_HASH",
            "authorizationHash must be 32 lowercase hex bytes",
        ));
    }
    if !is_hex_sig(&req.signature) {
        return Err(bad("BAD_SIGNATURE", "signature must be hex"));
    }
    if !matches!(
        req.submission_mode.as_str(),
        "private" | "solver" | "public-rpc" | "simulated"
    ) {
        return Err(bad("BAD_SUBMISSION_MODE", "unknown submission mode"));
    }

    let now = unix_now();
    let conn = app.0.db.lock().unwrap();
    let cur: Option<(String, i64)> = conn
        .query_row(
            "SELECT state, expires_at FROM intents WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(internal)?;

    let Some((state, expires_at)) = cur else {
        return Err(not_found("UNKNOWN_INTENT", "no such intent"));
    };
    if expires_at <= now {
        return Err(conflict("EXPIRED", "intent has expired"));
    }
    // The graph is the authority. An authorization arriving in any other state
    // is either a confused client or an attempt to skip the quote validation.
    if !can_transition(&state, "AUTHORIZED") {
        return Err(conflict(
            "ILLEGAL_TRANSITION",
            format!("cannot authorize from state {state}"),
        ));
    }

    conn.execute(
        "UPDATE intents SET state = 'AUTHORIZED', authorization_hash = ?1,
                            authorization_sig = ?2, submission_mode = ?3
         WHERE id = ?4",
        params![
            req.authorization_hash,
            req.signature,
            req.submission_mode,
            id
        ],
    )
    .map_err(internal)?;
    conn.execute(
        "INSERT INTO intent_events (intent_id, from_state, to_state, at) VALUES (?1, ?2, 'AUTHORIZED', ?3)",
        params![id, state, now],
    )
    .map_err(internal)?;

    Ok(Json(json!({"intentId": id, "state": "AUTHORIZED"})))
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn routes() -> Router<App> {
    Router::new()
        .route("/intents", post(submit_intent))
        .route("/intents/{id}", get(get_intent))
        .route("/intents/{id}/events", get(get_intent_events))
        .route("/intents/{id}/authorization", post(post_authorization))
        .route("/batches/{batch_id}/commitment", get(get_batch_commitment))
}

/// Record the ordering commitment for a frozen batch.
///
/// Called from the freeze path, BEFORE any operator is handed work. The
/// timestamp written here is what a receipt's `commitmentPrecedesReveal` check
/// compares against, so writing it late would silently invalidate the strongest
/// guarantee Peal makes.
pub fn record_commitment(
    conn: &rusqlite::Connection,
    batch_id: i64,
    condition_id: &str,
    ordering_root: &str,
    batch_size: usize,
    encryption_key_id: &str,
    committer: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO batch_commitments
           (batch_id, condition_id, ordering_root, batch_size, encryption_key_id, committer, committed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            batch_id,
            condition_id,
            ordering_root,
            batch_size as i64,
            encryption_key_id,
            committer.to_lowercase(),
            unix_now()
        ],
    )?;
    Ok(())
}

/// Advance every intent under a condition, validating each edge.
///
/// Intents that cannot legally make the move are left alone rather than forced:
/// a cancelled or failed intent must not be dragged back into the flow because
/// its batch happened to progress.
pub fn advance_condition_intents(
    conn: &rusqlite::Connection,
    condition_id: &str,
    to: &str,
) -> rusqlite::Result<usize> {
    let mut stmt = conn.prepare("SELECT id, state FROM intents WHERE condition_id = ?1")?;
    let rows: Vec<(String, String)> = stmt
        .query_map(params![condition_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;

    let now = unix_now();
    let mut moved = 0;
    for (id, from) in rows {
        if !can_transition(&from, to) {
            continue;
        }
        conn.execute(
            "UPDATE intents SET state = ?1 WHERE id = ?2",
            params![to, id],
        )?;
        conn.execute(
            "INSERT INTO intent_events (intent_id, from_state, to_state, at) VALUES (?1, ?2, ?3, ?4)",
            params![id, from, to, now],
        )?;
        moved += 1;
    }
    Ok(moved)
}
