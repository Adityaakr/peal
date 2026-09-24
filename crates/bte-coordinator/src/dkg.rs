//! The DKG relay: the coordinator as an untrusted bulletin board for the
//! operators' distributed key generation (`bte_crypto::tbte::dkg`).
//!
//! A round names the operators (identity key and box key each). Operators
//! post identity-signed envelopes (dealer commitments, sealed private
//! dealings, acknowledgements, signed logs); the relay verifies each
//! signature against the round's operator set, stores it once, and serves
//! them all back in arrival order. When enough signed logs are in, the
//! engine observes the same logs the players will finalize with, derives
//! the committee's public parameters, and registers the committee (scheme
//! v1). The relay never sees a share: private dealings are sealed to the
//! recipient's X25519 key, and the signatures make impersonation
//! impossible. What it can do is stall, which the round's status shows.

use anyhow::{Context, Result};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use base64::Engine;
use bte_crypto::tbte::dkg::{
    identity_key_bytes, identity_key_from_bytes, observe, Envelope, IdentityKey, Kind, RoundConfig,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::{internal, ApiError};
use crate::db::unix_now;
use crate::state::{new_id, App};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS dkg_rounds (
    id             TEXT PRIMARY KEY,
    committee_tag  TEXT NOT NULL,
    round          INTEGER NOT NULL,
    operators_json TEXT NOT NULL,          -- [{identity, box}] hex
    digest         TEXT NOT NULL,          -- round digest, hex
    status         TEXT NOT NULL,          -- open | complete | failed
    ack_deadline   INTEGER NOT NULL,       -- dealers close their logs after this
    created_at     INTEGER NOT NULL,
    committee_id   TEXT,
    output_b64     TEXT,
    logs_json      TEXT,                   -- envelope seqs the observer used
    error          TEXT
);
CREATE TABLE IF NOT EXISTS dkg_envelopes (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id    TEXT NOT NULL REFERENCES dkg_rounds(id),
    from_hex    TEXT NOT NULL,
    kind        INTEGER NOT NULL,
    to_hex      TEXT NOT NULL DEFAULT '',   -- '' for broadcasts (NULL would defeat UNIQUE)
    envelope    BLOB NOT NULL,
    received_at INTEGER NOT NULL,
    UNIQUE (round_id, from_hex, kind, to_hex)
);
CREATE INDEX IF NOT EXISTS idx_dkg_envelopes_round ON dkg_envelopes(round_id, seq);
"#;

/// Default time dealers wait for acknowledgements before closing their logs.
const DEFAULT_ACK_TIMEOUT_SECS: i64 = 60;
/// After the ack deadline, how long the observer waits for the last logs
/// before failing a round that is short of quorum.
const LOG_GRACE_SECS: i64 = 120;
/// Envelope size cap (a signed log for a large committee is a few KiB).
const MAX_ENVELOPE_BYTES: usize = 1 << 20;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct OperatorEntry {
    /// ed25519 identity key, hex (32 bytes).
    pub identity: String,
    /// X25519 box key, hex (32 bytes).
    #[serde(rename = "box")]
    pub box_key: String,
}

pub fn routes() -> Router<App> {
    Router::new()
        .route("/dkg/rounds", get(list_rounds).post(create_round))
        .route("/dkg/rounds/{id}", get(get_round))
        .route(
            "/dkg/rounds/{id}/envelopes",
            get(list_envelopes).post(post_envelope),
        )
        .route("/dkg/pending", get(pending_for))
}

fn bad(msg: impl Into<String>) -> ApiError {
    (StatusCode::BAD_REQUEST, Json(json!({"error": msg.into()})))
}

fn parse_operators(entries: &[OperatorEntry]) -> Result<Vec<IdentityKey>, String> {
    let mut keys = Vec::with_capacity(entries.len());
    for e in entries {
        let raw = hex::decode(&e.identity).map_err(|_| "identity is not hex")?;
        let key = identity_key_from_bytes(&raw).map_err(|e| e.to_string())?;
        let bx = hex::decode(&e.box_key).map_err(|_| "box key is not hex")?;
        if bx.len() != 32 {
            return Err("box key must be 32 bytes".into());
        }
        keys.push(key);
    }
    Ok(keys)
}

fn config_of(tag: &str, round: u64, entries: &[OperatorEntry]) -> Result<RoundConfig, String> {
    Ok(RoundConfig {
        committee_tag: tag.as_bytes().to_vec(),
        round,
        operators: parse_operators(entries)?,
    })
}

/// A round row, as the API and the engine read it.
struct RoundRow {
    id: String,
    committee_tag: String,
    round: u64,
    operators: Vec<OperatorEntry>,
    digest: String,
    status: String,
    ack_deadline: i64,
    created_at: i64,
    committee_id: Option<String>,
    output_b64: Option<String>,
    logs_json: Option<String>,
    error: Option<String>,
}

fn read_round(conn: &rusqlite::Connection, id: &str) -> rusqlite::Result<RoundRow> {
    conn.query_row(
        "SELECT id, committee_tag, round, operators_json, digest, status, ack_deadline,
                created_at, committee_id, output_b64, logs_json, error
         FROM dkg_rounds WHERE id = ?1",
        [id],
        |r| {
            let operators_json: String = r.get(3)?;
            Ok(RoundRow {
                id: r.get(0)?,
                committee_tag: r.get(1)?,
                round: r.get::<_, i64>(2)? as u64,
                operators: serde_json::from_str(&operators_json).unwrap_or_default(),
                digest: r.get(4)?,
                status: r.get(5)?,
                ack_deadline: r.get(6)?,
                created_at: r.get(7)?,
                committee_id: r.get(8)?,
                output_b64: r.get(9)?,
                logs_json: r.get(10)?,
                error: r.get(11)?,
            })
        },
    )
}

fn round_json(row: &RoundRow) -> Value {
    let config = config_of(&row.committee_tag, row.round, &row.operators).ok();
    json!({
        "id": row.id,
        "committee_tag": row.committee_tag,
        "round": row.round,
        "operators": row.operators,
        "digest": row.digest,
        "n": row.operators.len(),
        "threshold": config.as_ref().map(|c| c.threshold()),
        "quorum": config.as_ref().map(|c| c.quorum()),
        "status": row.status,
        "ack_deadline": row.ack_deadline,
        "created_at": row.created_at,
        "committee_id": row.committee_id,
        "output_b64": row.output_b64,
        "logs": row.logs_json.as_deref().and_then(|s| serde_json::from_str::<Vec<i64>>(s).ok()),
        "error": row.error,
    })
}

#[derive(Deserialize)]
struct CreateRound {
    committee_tag: String,
    operators: Vec<OperatorEntry>,
    /// Seconds dealers wait for acknowledgements; default 60.
    ack_timeout_secs: Option<i64>,
}

/// Starting a round is an operator action, not a public one: it needs the
/// admin token (`BTE_ADMIN_TOKEN`), or the dev flag.
fn require_admin(app: &App, headers: &HeaderMap) -> Result<(), ApiError> {
    let presented = headers
        .get("x-bte-admin")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    match (&app.0.cfg.admin_token, app.0.cfg.dev) {
        (Some(token), _) if !token.is_empty() && presented == token => Ok(()),
        (_, true) => Ok(()),
        _ => Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "starting a DKG round needs the admin token"})),
        )),
    }
}

async fn create_round(
    State(app): State<App>,
    headers: HeaderMap,
    Json(req): Json<CreateRound>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&app, &headers)?;
    if req.committee_tag.is_empty() || req.committee_tag.len() > 64 {
        return Err(bad("committee_tag must be 1..64 bytes"));
    }
    if req.operators.len() < 2 || req.operators.len() > 256 {
        return Err(bad("a round needs 2..256 operators"));
    }
    let conn = app.0.db.lock().unwrap();
    // Round numbers increase per committee tag, failed rounds included.
    let round: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(round) + 1, 0) FROM dkg_rounds WHERE committee_tag = ?1",
            [&req.committee_tag],
            |r| r.get(0),
        )
        .map_err(internal)?;
    let config = config_of(&req.committee_tag, round as u64, &req.operators).map_err(bad)?;
    let mut operators = req.operators.clone();
    operators.sort_by(|a, b| a.identity.cmp(&b.identity));
    let id = new_id("dkg");
    let now = unix_now();
    let ack_deadline = now
        + req
            .ack_timeout_secs
            .unwrap_or(DEFAULT_ACK_TIMEOUT_SECS)
            .clamp(5, 3600);
    conn.execute(
        "INSERT INTO dkg_rounds (id, committee_tag, round, operators_json, digest, status,
                                 ack_deadline, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?7)",
        rusqlite::params![
            id,
            req.committee_tag,
            round,
            serde_json::to_string(&operators).map_err(internal)?,
            hex::encode(config.digest()),
            ack_deadline,
            now
        ],
    )
    .map_err(internal)?;
    let row = read_round(&conn, &id).map_err(internal)?;
    Ok(Json(round_json(&row)))
}

async fn list_rounds(State(app): State<App>) -> Result<Json<Value>, ApiError> {
    let conn = app.0.db.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id FROM dkg_rounds ORDER BY created_at DESC LIMIT 100")
        .map_err(internal)?;
    let ids: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;
    let rounds: Vec<Value> = ids
        .iter()
        .filter_map(|id| read_round(&conn, id).ok())
        .map(|row| round_json(&row))
        .collect();
    Ok(Json(json!({"rounds": rounds})))
}

async fn get_round(
    State(app): State<App>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let conn = app.0.db.lock().unwrap();
    let row = read_round(&conn, &id).map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "unknown round"})),
        )
    })?;
    Ok(Json(round_json(&row)))
}

#[derive(Deserialize)]
struct PendingQuery {
    identity: String,
}

/// Every round an operator identity takes part in, newest first, so a node
/// discovers its rounds by asking once per poll.
async fn pending_for(
    State(app): State<App>,
    Query(q): Query<PendingQuery>,
) -> Result<Json<Value>, ApiError> {
    let needle = q.identity.to_lowercase();
    let conn = app.0.db.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id FROM dkg_rounds ORDER BY created_at DESC LIMIT 200")
        .map_err(internal)?;
    let ids: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;
    let rounds: Vec<Value> = ids
        .iter()
        .filter_map(|id| read_round(&conn, id).ok())
        .filter(|row| {
            row.operators
                .iter()
                .any(|o| o.identity.to_lowercase() == needle)
        })
        .map(|row| round_json(&row))
        .collect();
    Ok(Json(json!({"rounds": rounds})))
}

#[derive(Deserialize)]
struct EnvelopeQuery {
    since: Option<i64>,
}

async fn list_envelopes(
    State(app): State<App>,
    Path(id): Path<String>,
    Query(q): Query<EnvelopeQuery>,
) -> Result<Json<Value>, ApiError> {
    let conn = app.0.db.lock().unwrap();
    read_round(&conn, &id).map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "unknown round"})),
        )
    })?;
    let mut stmt = conn
        .prepare(
            "SELECT seq, envelope FROM dkg_envelopes WHERE round_id = ?1 AND seq > ?2
             ORDER BY seq ASC",
        )
        .map_err(internal)?;
    let rows: Vec<Value> = stmt
        .query_map(rusqlite::params![id, q.since.unwrap_or(0)], |r| {
            Ok(json!({
                "seq": r.get::<_, i64>(0)?,
                "envelope_b64": B64.encode(r.get::<_, Vec<u8>>(1)?),
            }))
        })
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;
    Ok(Json(json!({"envelopes": rows})))
}

#[derive(Deserialize)]
struct PostEnvelope {
    envelope_b64: String,
}

/// Accept an envelope: it must parse, be signed by an operator of this
/// round, and name this round. Duplicates (same sender, kind, recipient)
/// keep the first.
async fn post_envelope(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(req): Json<PostEnvelope>,
) -> Result<Json<Value>, ApiError> {
    if req.envelope_b64.len() > MAX_ENVELOPE_BYTES * 4 / 3 + 8 {
        return Err(bad("envelope too large"));
    }
    let bytes = B64
        .decode(&req.envelope_b64)
        .map_err(|_| bad("envelope_b64 is not valid base64"))?;
    let envelope = Envelope::from_bytes(&bytes).map_err(|e| bad(format!("bad envelope: {e}")))?;
    let conn = app.0.db.lock().unwrap();
    let row = read_round(&conn, &id).map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "unknown round"})),
        )
    })?;
    if row.status != "open" {
        return Err(bad(format!("round is {}", row.status)));
    }
    let config = config_of(&row.committee_tag, row.round, &row.operators).map_err(internal)?;
    if !envelope.verify(&config) {
        return Err(bad("envelope signature or membership check failed"));
    }
    let to_hex = envelope
        .to
        .as_ref()
        .map(|k| hex::encode(identity_key_bytes(k)))
        .unwrap_or_default();
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO dkg_envelopes (round_id, from_hex, kind, to_hex, envelope, received_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                id,
                hex::encode(identity_key_bytes(&envelope.from)),
                envelope.kind as u8 as i64,
                to_hex,
                bytes,
                unix_now()
            ],
        )
        .map_err(internal)?;
    Ok(Json(json!({"accepted": inserted == 1})))
}

/// Signed dealer logs posted to a round, with their sequence numbers.
fn round_logs(conn: &rusqlite::Connection, round_id: &str) -> Result<Vec<(i64, Vec<u8>)>> {
    let mut stmt = conn.prepare(
        "SELECT seq, envelope FROM dkg_envelopes WHERE round_id = ?1 AND kind = ?2 ORDER BY seq ASC",
    )?;
    let rows = stmt.query_map(rusqlite::params![round_id, Kind::Log as u8 as i64], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
    })?;
    let mut logs = Vec::new();
    for row in rows {
        let (seq, bytes) = row?;
        let envelope = Envelope::from_bytes(&bytes)?;
        logs.push((seq, envelope.payload));
    }
    Ok(logs)
}

/// One engine pass over open rounds: observe once enough logs are in.
pub fn tick(app: &App) -> Result<()> {
    let open: Vec<String> = {
        let conn = app.0.db.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM dkg_rounds WHERE status = 'open'")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    for id in open {
        if let Err(e) = settle_round(app, &id) {
            tracing::warn!(round = id, error = %e, "dkg round settlement failed");
        }
    }
    Ok(())
}

fn settle_round(app: &App, id: &str) -> Result<()> {
    let (row, logs) = {
        let conn = app.0.db.lock().unwrap();
        let row = read_round(&conn, id)?;
        let logs = round_logs(&conn, id)?;
        (row, logs)
    };
    let config =
        config_of(&row.committee_tag, row.round, &row.operators).map_err(|e| anyhow::anyhow!(e))?;
    let n = row.operators.len();
    let quorum = config.quorum() as usize;
    let now = unix_now();
    let all_in = logs.len() >= n;
    let past_deadline = now >= row.ack_deadline;
    if logs.len() < quorum {
        if now >= row.ack_deadline + LOG_GRACE_SECS {
            fail_round(
                app,
                id,
                &format!(
                    "only {} of {n} dealer logs arrived (quorum {quorum})",
                    logs.len()
                ),
            )?;
        }
        return Ok(());
    }
    // Wait for every dealer while the deadline has not passed, so players and
    // observer settle on the same, fullest set of logs.
    if !all_in && !past_deadline {
        return Ok(());
    }
    let seqs: Vec<i64> = logs.iter().map(|(seq, _)| *seq).collect();
    let bytes: Vec<Vec<u8>> = logs.into_iter().map(|(_, b)| b).collect();
    let mut seed = [0u8; 32];
    bte_crypto::rand::RngCore::fill_bytes(&mut bte_crypto::os_rng(), &mut seed);
    match observe(&config, &bytes, seed) {
        Ok(result) => {
            let committee_id = app
                .register_committee(&result.params.to_bytes())
                .context("registering the DKG committee")?;
            let conn = app.0.db.lock().unwrap();
            conn.execute(
                "UPDATE dkg_rounds SET status = 'complete', committee_id = ?2, output_b64 = ?3,
                                       logs_json = ?4 WHERE id = ?1",
                rusqlite::params![
                    id,
                    committee_id,
                    B64.encode(&result.output),
                    serde_json::to_string(&seqs)?
                ],
            )?;
            tracing::info!(
                round = id,
                committee = committee_id,
                n,
                threshold = result.params.t(),
                "dkg round complete, committee registered"
            );
        }
        Err(e) => {
            if all_in || now >= row.ack_deadline + LOG_GRACE_SECS {
                fail_round(app, id, &format!("{e}"))?;
            }
        }
    }
    Ok(())
}

fn fail_round(app: &App, id: &str, error: &str) -> Result<()> {
    let conn = app.0.db.lock().unwrap();
    conn.execute(
        "UPDATE dkg_rounds SET status = 'failed', error = ?2 WHERE id = ?1",
        rusqlite::params![id, error],
    )?;
    tracing::warn!(round = id, error, "dkg round failed");
    Ok(())
}
