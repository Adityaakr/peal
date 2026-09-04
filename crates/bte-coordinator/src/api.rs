//! REST API (axum, JSON, /v0). See spec/index.md section 6.

use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use bte_crypto::wire::header_to_bytes;
use bte_crypto::{verify_share, SealedCiphertext, Share};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::db::{now_ms, unix_now};
use crate::state::{new_id, new_share_code, App};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
/// Sealed wire blob cap: framing + 48 + 16 + payload cap, with headroom.
const MAX_SEALED_BLOB: usize = bte_crypto::MAX_PAYLOAD_BYTES + 4096;

pub(crate) type ApiError = (StatusCode, Json<Value>);

fn bad_request(msg: impl Into<String>) -> ApiError {
    (StatusCode::BAD_REQUEST, Json(json!({"error": msg.into()})))
}

fn not_found(msg: &str) -> ApiError {
    (StatusCode::NOT_FOUND, Json(json!({"error": msg})))
}

pub(crate) fn internal(e: impl std::fmt::Display) -> ApiError {
    tracing::error!(error = %e, "internal error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": "internal error"})),
    )
}

pub fn router(app: App) -> Router {
    let api = Router::new()
        .route("/conditions", get(list_conditions).post(create_condition))
        .route("/conditions/{id}", get(get_condition))
        .route("/ciphertexts", post(submit_ciphertext))
        .route("/work", get(get_work))
        .route("/shares", post(submit_share))
        .route("/reveals/{condition_id}", get(get_reveal))
        .route("/seals/{code}", get(resolve_seal))
        .route("/committees", get(list_committees).post(register_committee))
        .route("/committees/{id}", get(get_committee))
        .route("/stats", get(crate::stats::get_stats))
        .route("/healthz", get(|| async { Json(json!({"ok": true})) }));
    Router::new()
        .nest("/v0", api)
        .nest("/v1", crate::intents::routes())
        // The app shell for a short link, with that auction's own preview meta
        // written into it. Caddy rewrites `/{name}` onto this; the browser's
        // address bar keeps the pretty path. See names.rs.
        .route("/link/{name}", get(crate::names::named_shell))
        // Bounded by the one route that carries bulk: a sealed blob arrives
        // base64'd inside JSON, so 4/3 of the blob cap plus slack for the
        // surrounding fields. This is what a request may BUFFER, so it is kept
        // tight to the real maximum rather than left as a loose multiple.
        .layer(DefaultBodyLimit::max(MAX_SEALED_BLOB * 4 / 3 + 64 * 1024))
        .layer(axum::middleware::from_fn_with_state(
            app.clone(),
            rate_limit,
        ))
        .layer(axum::middleware::from_fn(cors))
        .with_state(app)
}

/// Permissive CORS for the read-only explorer (dev/testnet API, no cookies).
async fn cors(request: axum::extract::Request, next: axum::middleware::Next) -> Response {
    use axum::http::{header, HeaderValue, Method};
    let mut response = if request.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type"),
    );
    response
}

/// Token-bucket per client IP (x-forwarded-for first hop, else socket addr,
/// else "local" for in-process tests). Generous dev defaults via BTE_RATE_*.
async fn rate_limit(
    State(app): State<App>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let ip = request
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').next().unwrap_or(v).trim().to_string())
        .or_else(|| {
            request
                .extensions()
                .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                .map(|ci| ci.0.ip().to_string())
        })
        .unwrap_or_else(|| "local".to_string());

    let allowed = {
        let cfg = &app.0.cfg;
        let mut buckets = app.0.buckets.lock().unwrap();
        let now = now_ms();
        let (tokens, last) = buckets.entry(ip).or_insert((cfg.rate_burst, now));
        *tokens = (*tokens + (now - *last) as f64 / 1000.0 * cfg.rate_rps).min(cfg.rate_burst);
        *last = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            true
        } else {
            false
        }
    };
    if !allowed {
        // A throttled API call is a JSON error, but a throttled PAGE must still
        // be a page. /link/{name} is a person opening a short link, so it
        // degrades to the shell with no custom preview rather than showing them
        // a JSON error where an auction should be. The limiter still did its
        // job: the chain lookup behind the preview was skipped.
        if request.uri().path().starts_with("/link/") {
            return crate::names::plain_shell();
        }
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error": "rate limited"})),
        )
            .into_response();
    }
    next.run(request).await
}

#[derive(Deserialize)]
struct CreateCondition {
    committee_id: Option<String>,
    kind: Option<String>,
    /// Absolute unix seconds…
    fires_at: Option<i64>,
    /// …or relative seconds from now.
    in_secs: Option<i64>,
    /// at_block (phase 7)
    chain_id: Option<i64>,
    height: Option<i64>,
    /// Optional client label so apps can find their own conditions
    /// (e.g. "round:bid", "capsule"). Not interpreted by the coordinator.
    tag: Option<String>,
}

async fn create_condition(
    State(app): State<App>,
    Json(req): Json<CreateCondition>,
) -> Result<Json<Value>, ApiError> {
    let committee_id = match req.committee_id {
        Some(id) => id,
        None => default_committee(&app).ok_or_else(|| bad_request("no committee registered"))?,
    };
    if app.committee(&committee_id).is_none() {
        return Err(bad_request("unknown committee"));
    }
    let kind = req.kind.unwrap_or_else(|| "at_time".into());
    let tag = match req.tag {
        Some(t) => {
            if t.len() > 32
                || !t.bytes().all(|b| {
                    b.is_ascii_lowercase()
                        || b.is_ascii_digit()
                        || b == b':'
                        || b == b'-'
                        || b == b'_'
                })
            {
                return Err(bad_request("tag must be <=32 chars of [a-z0-9:_-]"));
            }
            Some(t)
        }
        None => None,
    };
    let id = new_id("cond");
    let now = unix_now();
    match kind.as_str() {
        "at_time" => {
            let fires_at = match (req.fires_at, req.in_secs) {
                (Some(at), _) => at,
                (None, Some(in_secs)) => now + in_secs,
                _ => return Err(bad_request("at_time needs fires_at or in_secs")),
            };
            if fires_at < now {
                return Err(bad_request("fires_at is in the past"));
            }
            let conn = app.0.db.lock().unwrap();
            conn.execute(
                "INSERT INTO conditions (id, committee_id, kind, fires_at, status, tag, created_at)
                 VALUES (?1, ?2, 'at_time', ?3, 'pending', ?4, ?5)",
                rusqlite::params![id, committee_id, fires_at, tag, now],
            )
            .map_err(internal)?;
            Ok(Json(json!({
                "id": id, "committee_id": committee_id, "kind": "at_time",
                "fires_at": fires_at, "status": "pending", "tag": tag
            })))
        }
        "at_block" => {
            let (chain_id, height) = match (req.chain_id, req.height) {
                (Some(c), Some(h)) => (c, h),
                _ => return Err(bad_request("at_block needs chain_id and height")),
            };
            if !app.0.cfg.rpc_urls.contains_key(&chain_id) {
                return Err(bad_request(format!(
                    "no RPC configured for chain {chain_id} (set SEPOLIA_RPC_URL or BTE_RPC_URL_{chain_id})"
                )));
            }
            let conn = app.0.db.lock().unwrap();
            conn.execute(
                "INSERT INTO conditions (id, committee_id, kind, chain_id, height, status, created_at)
                 VALUES (?1, ?2, 'at_block', ?3, ?4, 'pending', ?5)",
                rusqlite::params![id, committee_id, chain_id, height, now],
            )
            .map_err(internal)?;
            Ok(Json(json!({
                "id": id, "committee_id": committee_id, "kind": "at_block",
                "chain_id": chain_id, "height": height, "status": "pending"
            })))
        }
        _ => Err(bad_request("kind must be at_time or at_block")),
    }
}

async fn list_conditions(State(app): State<App>) -> Result<Json<Value>, ApiError> {
    let conn = app.0.db.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.committee_id, c.kind, c.fires_at, c.status, c.created_at, c.tag,
                    COUNT(x.ct_hash), COALESCE(SUM(x.is_dummy = 0), 0)
             FROM conditions c LEFT JOIN ciphertexts x ON x.condition_id = c.id
             GROUP BY c.id ORDER BY c.created_at DESC LIMIT 100",
        )
        .map_err(internal)?;
    let rows: Vec<Value> = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "committee_id": r.get::<_, String>(1)?,
                "kind": r.get::<_, String>(2)?,
                "fires_at": r.get::<_, Option<i64>>(3)?,
                "status": r.get::<_, String>(4)?,
                "created_at": r.get::<_, i64>(5)?,
                "tag": r.get::<_, Option<String>>(6)?,
                "ciphertext_count": r.get::<_, i64>(7)?,
                "real_count": r.get::<_, i64>(8)?,
            }))
        })
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;

    // How many exist, not how many were returned. The list is capped at 100, so
    // a client counting the array it received would report 100 forever once the
    // network passed that, which reads as "nothing is happening" precisely when
    // the most is.
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM conditions", [], |r| r.get(0))
        .map_err(internal)?;

    Ok(Json(json!({"conditions": rows, "total": total})))
}

async fn get_condition(
    State(app): State<App>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let conn = app.0.db.lock().unwrap();
    let row = conn
        .query_row(
            "SELECT committee_id, kind, fires_at, chain_id, height, status, created_at, tag
             FROM conditions WHERE id = ?1",
            [&id],
            |r| {
                Ok(json!({
                    "id": id.clone(),
                    "committee_id": r.get::<_, String>(0)?,
                    "kind": r.get::<_, String>(1)?,
                    "fires_at": r.get::<_, Option<i64>>(2)?,
                    "chain_id": r.get::<_, Option<i64>>(3)?,
                    "height": r.get::<_, Option<i64>>(4)?,
                    "status": r.get::<_, String>(5)?,
                    "created_at": r.get::<_, i64>(6)?,
                    "tag": r.get::<_, Option<String>>(7)?,
                }))
            },
        )
        .map_err(|_| not_found("unknown condition"))?;
    let mut body = row;
    let counts: (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(is_dummy = 0), 0) FROM ciphertexts WHERE condition_id = ?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(internal)?;
    body["ciphertext_count"] = json!(counts.0);
    body["real_count"] = json!(counts.1);
    let mut stmt = conn
        .prepare(
            "SELECT b.id, b.batch_index, b.frozen_at, b.finalized_at, b.predecrypt_ms, b.finalize_ms,
                    (SELECT COUNT(*) FROM shares s WHERE s.batch_id = b.id AND s.verified = 1),
                    (SELECT COUNT(*) FROM shares s WHERE s.batch_id = b.id)
             FROM batches b WHERE b.condition_id = ?1 ORDER BY b.batch_index",
        )
        .map_err(internal)?;
    let batches: Vec<Value> = stmt
        .query_map([&id], |r| {
            Ok(json!({
                "batch_id": r.get::<_, i64>(0)?,
                "batch_index": r.get::<_, i64>(1)?,
                "frozen_at": r.get::<_, i64>(2)?,
                "finalized_at": r.get::<_, Option<i64>>(3)?,
                "predecrypt_ms": r.get::<_, Option<i64>>(4)?,
                "finalize_ms": r.get::<_, Option<i64>>(5)?,
                "verified_shares": r.get::<_, i64>(6)?,
                "total_shares": r.get::<_, i64>(7)?,
            }))
        })
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;
    body["batches"] = json!(batches);
    Ok(Json(body))
}

#[derive(Deserialize)]
struct SubmitCiphertext {
    condition_id: String,
    sealed_blob_b64: String,
}

async fn submit_ciphertext(
    State(app): State<App>,
    Json(req): Json<SubmitCiphertext>,
) -> Result<Json<Value>, ApiError> {
    if req.sealed_blob_b64.len() > MAX_SEALED_BLOB * 4 / 3 + 8 {
        return Err(bad_request("sealed blob too large"));
    }
    let blob = B64
        .decode(&req.sealed_blob_b64)
        .map_err(|_| bad_request("sealed_blob_b64 is not valid base64"))?;
    if blob.len() > MAX_SEALED_BLOB {
        return Err(bad_request("sealed blob too large"));
    }
    // Strict validation: parses, on-curve, subgroup-checked, payload cap.
    let ct = SealedCiphertext::from_bytes(&blob)
        .map_err(|e| bad_request(format!("invalid sealed ciphertext: {e}")))?;
    let ct_hash = hex::encode(ct.hash());

    let conn = app.0.db.lock().unwrap();
    let status: String = conn
        .query_row(
            "SELECT status FROM conditions WHERE id = ?1",
            [&req.condition_id],
            |r| r.get(0),
        )
        .map_err(|_| not_found("unknown condition"))?;
    if status != "pending" {
        return Err(bad_request(format!(
            "condition is {status}; sealing is closed"
        )));
    }
    conn.execute(
        "INSERT OR IGNORE INTO ciphertexts (ct_hash, condition_id, sealed_blob, is_dummy, created_at, code)
         VALUES (?1, ?2, ?3, 0, ?4, ?5)",
        rusqlite::params![
            ct_hash,
            req.condition_id,
            blob,
            unix_now(),
            new_share_code()
        ],
    )
    .map_err(internal)?;
    // OR IGNORE means a replayed seal keeps the original row, so read the code
    // back rather than returning the candidate we just generated. Rows written
    // before the code column existed get one backfilled here.
    conn.execute(
        "UPDATE ciphertexts SET code = ?2 WHERE ct_hash = ?1 AND code IS NULL",
        rusqlite::params![ct_hash, new_share_code()],
    )
    .map_err(internal)?;
    let code: String = conn
        .query_row(
            "SELECT code FROM ciphertexts WHERE ct_hash = ?1",
            [&ct_hash],
            |r| r.get(0),
        )
        .map_err(internal)?;
    Ok(Json(json!({"ct_hash": ct_hash, "code": code})))
}

/// Resolve a short share code to the seal it names. The code is an opaque
/// server-issued identifier; the decryption key for a private seal never
/// reaches here, it stays in the link's URL fragment.
async fn resolve_seal(
    State(app): State<App>,
    Path(code): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if code.len() > 32
        || !code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(bad_request("malformed share code"));
    }
    let conn = app.0.db.lock().unwrap();
    conn.query_row(
        "SELECT ct_hash, condition_id FROM ciphertexts WHERE code = ?1",
        [&code],
        |r| {
            Ok(Json(json!({
                "ct_hash": r.get::<_, String>(0)?,
                "condition_id": r.get::<_, String>(1)?,
            })))
        },
    )
    .map_err(|_| not_found("unknown share code"))
}

#[derive(Deserialize)]
struct WorkQuery {
    operator: u16,
}

/// Frozen batches still missing a share from this operator, headers in
/// position order (B * 48 bytes, base64).
async fn get_work(
    State(app): State<App>,
    Query(q): Query<WorkQuery>,
) -> Result<Json<Value>, ApiError> {
    let conn = app.0.db.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT b.id, b.condition_id, b.batch_index, k.b
             FROM batches b
             JOIN conditions c ON c.id = b.condition_id
             JOIN committees k ON k.id = c.committee_id
             WHERE b.finalized_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM shares s
                               WHERE s.batch_id = b.id AND s.operator_id = ?1)",
        )
        .map_err(internal)?;
    let batch_rows: Vec<(i64, String, i64, i64)> = stmt
        .query_map([q.operator], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;

    let mut batches = Vec::new();
    for (batch_id, condition_id, batch_index, b) in batch_rows {
        let lo = batch_index * b;
        let hi = lo + b;
        let mut stmt = conn
            .prepare(
                "SELECT sealed_blob FROM ciphertexts
                 WHERE condition_id = ?1 AND position >= ?2 AND position < ?3
                 ORDER BY position ASC",
            )
            .map_err(internal)?;
        let blobs: Vec<Vec<u8>> = stmt
            .query_map(rusqlite::params![condition_id, lo, hi], |r| r.get(0))
            .map_err(internal)?
            .collect::<Result<_, _>>()
            .map_err(internal)?;
        let mut headers = Vec::with_capacity(blobs.len() * 48);
        for blob in &blobs {
            let ct = SealedCiphertext::from_bytes(blob).map_err(internal)?;
            headers.extend_from_slice(&header_to_bytes(&ct.header()));
        }
        batches.push(json!({
            "batch_id": batch_id,
            "condition_id": condition_id,
            "b": b,
            "headers_b64": B64.encode(&headers),
        }));
    }
    Ok(Json(json!({"batches": batches})))
}

#[derive(Deserialize)]
struct SubmitShare {
    batch_id: i64,
    operator_id: u16,
    share_b64: String,
}

/// verify_share runs inline; rejected shares are stored flagged and never
/// used for recovery.
async fn submit_share(
    State(app): State<App>,
    Json(req): Json<SubmitShare>,
) -> Result<Json<Value>, ApiError> {
    let blob = B64
        .decode(&req.share_b64)
        .map_err(|_| bad_request("share_b64 is not valid base64"))?;
    let share = Share::from_bytes(&blob).map_err(|e| bad_request(format!("invalid share: {e}")))?;
    if share.party_index != req.operator_id {
        return Err(bad_request("share party index does not match operator_id"));
    }

    // Load batch headers + committee for verification (read lock scope).
    let (condition_id, committee_id, headers) = {
        let conn = app.0.db.lock().unwrap();
        let (condition_id, batch_index): (String, i64) = conn
            .query_row(
                "SELECT condition_id, batch_index FROM batches WHERE id = ?1 AND finalized_at IS NULL",
                [req.batch_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| not_found("unknown or already finalized batch"))?;
        let committee_id: String = conn
            .query_row(
                "SELECT committee_id FROM conditions WHERE id = ?1",
                [&condition_id],
                |r| r.get(0),
            )
            .map_err(internal)?;
        let b: i64 = conn
            .query_row(
                "SELECT b FROM committees WHERE id = ?1",
                [&committee_id],
                |r| r.get(0),
            )
            .map_err(internal)?;
        let existing: Option<i64> = conn
            .query_row(
                "SELECT verified FROM shares WHERE batch_id = ?1 AND operator_id = ?2",
                rusqlite::params![req.batch_id, req.operator_id],
                |r| r.get(0),
            )
            .ok();
        if let Some(verified) = existing {
            return Ok(Json(json!({"verified": verified != 0, "duplicate": true})));
        }
        let lo = batch_index * b;
        let hi = lo + b;
        let mut stmt = conn
            .prepare(
                "SELECT sealed_blob FROM ciphertexts
                 WHERE condition_id = ?1 AND position >= ?2 AND position < ?3
                 ORDER BY position ASC",
            )
            .map_err(internal)?;
        let blobs: Vec<Vec<u8>> = stmt
            .query_map(rusqlite::params![condition_id, lo, hi], |r| r.get(0))
            .map_err(internal)?
            .collect::<Result<_, _>>()
            .map_err(internal)?;
        let headers: Vec<bte_crypto::CtHeader> = blobs
            .iter()
            .map(|blob| SealedCiphertext::from_bytes(blob).map(|ct| ct.header()))
            .collect::<Result<_, _>>()
            .map_err(internal)?;
        (condition_id, committee_id, headers)
    };

    let committee = app
        .committee(&committee_id)
        .ok_or_else(|| internal("committee not cached"))?;
    let params = committee.params.clone();
    let verified = tokio::task::spawn_blocking(move || verify_share(&params, &headers, &share))
        .await
        .map_err(internal)?;

    {
        let conn = app.0.db.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO shares (batch_id, operator_id, share_blob, verified, submitted_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![req.batch_id, req.operator_id, blob, verified as i64, now_ms()],
        )
        .map_err(internal)?;
    }
    if !verified {
        tracing::warn!(
            batch_id = req.batch_id,
            operator = req.operator_id,
            condition_id,
            "rejected invalid share"
        );
    }
    Ok(Json(json!({"verified": verified, "duplicate": false})))
}

/// 404 until the condition is revealed (invariant 4: no plaintext before
/// reveal). After: plaintexts + per-operator share log + timings.
///
/// Everything a third party needs to re-derive our claims ships with the
/// reveal, because a "verification" that reads its expected value from us
/// proves only that we are self-consistent. So each slot carries the sealed
/// ciphertext it opened (`sealed_b64` -> re-hash it, that is the ct_hash), each
/// batch carries its packed headers, and each share carries its bytes (feed
/// both to verify_share and the t-of-n pairing check runs in the browser).
/// None of this is secret once the condition is revealed.
async fn get_reveal(
    State(app): State<App>,
    Path(condition_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let conn = app.0.db.lock().unwrap();
    let (revealed_at, payloads_json, merkle_root): (i64, String, String) = conn
        .query_row(
            "SELECT revealed_at, payloads_blob, merkle_root FROM reveals WHERE condition_id = ?1",
            [&condition_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| not_found("not revealed"))?;

    // Attach the sealed ciphertext to the slot it opened, keyed by ct_hash. The
    // reveal's payloads_blob was frozen at reveal time and has no bytes in it.
    let mut stmt = conn
        .prepare("SELECT ct_hash, sealed_blob FROM ciphertexts WHERE condition_id = ?1")
        .map_err(internal)?;
    let sealed: HashMap<String, Vec<u8>> = stmt
        .query_map([&condition_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
        })
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;

    let mut slots: Value = serde_json::from_str(&payloads_json).map_err(internal)?;
    if let Some(arr) = slots.as_array_mut() {
        for slot in arr.iter_mut() {
            let hash = slot.get("ct_hash").and_then(Value::as_str).unwrap_or("");
            if let (Some(blob), Some(obj)) = (sealed.get(hash), slot.as_object_mut()) {
                obj.insert("sealed_b64".into(), json!(B64.encode(blob)));
            }
        }
    }

    let mut stmt = conn
        .prepare(
            "SELECT s.batch_id, s.operator_id, s.verified, s.submitted_at, s.share_blob
             FROM shares s JOIN batches b ON b.id = s.batch_id
             WHERE b.condition_id = ?1 ORDER BY s.submitted_at ASC",
        )
        .map_err(internal)?;
    let share_log: Vec<Value> = stmt
        .query_map([&condition_id], |r| {
            Ok(json!({
                "batch_id": r.get::<_, i64>(0)?,
                "operator_id": r.get::<_, i64>(1)?,
                "verified": r.get::<_, i64>(2)? != 0,
                "submitted_at_ms": r.get::<_, i64>(3)?,
                "share_b64": B64.encode(r.get::<_, Vec<u8>>(4)?),
            }))
        })
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, batch_index, predecrypt_ms, finalize_ms FROM batches
             WHERE condition_id = ?1 ORDER BY batch_index",
        )
        .map_err(internal)?;
    let batch_rows: Vec<(i64, i64, Option<i64>, Option<i64>)> = stmt
        .query_map([&condition_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;

    // The packed B*48 headers per batch, the other half of the share check.
    // /v0/work serves these too, but only for batches still open, so a revealed
    // condition's headers are unreachable there.
    let b: i64 = conn
        .query_row(
            "SELECT k.b FROM committees k JOIN conditions c ON c.committee_id = k.id
             WHERE c.id = ?1",
            [&condition_id],
            |r| r.get(0),
        )
        .map_err(internal)?;
    let mut batches = Vec::with_capacity(batch_rows.len());
    for (batch_id, batch_index, predecrypt_ms, finalize_ms) in batch_rows {
        let headers = batch_headers(&conn, &condition_id, batch_index, b)?;
        batches.push(json!({
            "batch_id": batch_id,
            "batch_index": batch_index,
            "predecrypt_ms": predecrypt_ms,
            "finalize_ms": finalize_ms,
            "headers_b64": B64.encode(&headers),
        }));
    }

    Ok(Json(json!({
        "condition_id": condition_id,
        "revealed_at": revealed_at,
        "merkle_root": merkle_root,
        "slots": slots,
        "shares": share_log,
        "batches": batches,
    })))
}

/// The batch's ciphertext headers, packed in position order (B * 48 bytes).
fn batch_headers(
    conn: &rusqlite::Connection,
    condition_id: &str,
    batch_index: i64,
    b: i64,
) -> Result<Vec<u8>, ApiError> {
    let lo = batch_index * b;
    let hi = lo + b;
    let mut stmt = conn
        .prepare(
            "SELECT sealed_blob FROM ciphertexts
             WHERE condition_id = ?1 AND position >= ?2 AND position < ?3
             ORDER BY position ASC",
        )
        .map_err(internal)?;
    let blobs: Vec<Vec<u8>> = stmt
        .query_map(rusqlite::params![condition_id, lo, hi], |r| r.get(0))
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;
    let mut headers = Vec::with_capacity(blobs.len() * 48);
    for blob in &blobs {
        let ct = SealedCiphertext::from_bytes(blob).map_err(internal)?;
        headers.extend_from_slice(&header_to_bytes(&ct.header()));
    }
    Ok(headers)
}

fn default_committee(app: &App) -> Option<String> {
    let conn = app.0.db.lock().unwrap();
    conn.query_row(
        "SELECT id FROM committees ORDER BY created_at DESC, id LIMIT 1",
        [],
        |r| r.get(0),
    )
    .ok()
}

#[derive(Deserialize)]
struct RegisterCommittee {
    params_b64: String,
}

async fn register_committee(
    State(app): State<App>,
    Json(req): Json<RegisterCommittee>,
) -> Result<Json<Value>, ApiError> {
    let blob = B64
        .decode(&req.params_b64)
        .map_err(|_| bad_request("params_b64 is not valid base64"))?;
    let id = app
        .register_committee(&blob)
        .map_err(|e| bad_request(format!("invalid params: {e}")))?;
    Ok(Json(json!({"id": id})))
}

async fn list_committees(State(app): State<App>) -> Result<Json<Value>, ApiError> {
    let conn = app.0.db.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, n, t, b, created_at FROM committees ORDER BY created_at DESC")
        .map_err(internal)?;
    let rows: Vec<Value> = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "n": r.get::<_, i64>(1)?,
                "t": r.get::<_, i64>(2)?,
                "b": r.get::<_, i64>(3)?,
                "created_at": r.get::<_, i64>(4)?,
            }))
        })
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;
    Ok(Json(json!({"committees": rows})))
}

#[derive(Serialize)]
struct CommitteeDetail {
    id: String,
    n: i64,
    t: i64,
    b: i64,
    params_b64: String,
    params_digest: String,
    created_at: i64,
}

async fn get_committee(
    State(app): State<App>,
    Path(id): Path<String>,
) -> Result<Json<CommitteeDetail>, ApiError> {
    let resolved = if id == "default" {
        default_committee(&app).ok_or_else(|| not_found("no committee registered"))?
    } else {
        id
    };
    let conn = app.0.db.lock().unwrap();
    conn.query_row(
        "SELECT id, n, t, b, params_blob, created_at FROM committees WHERE id = ?1",
        [&resolved],
        |r| {
            Ok(CommitteeDetail {
                id: r.get(0)?,
                n: r.get(1)?,
                t: r.get(2)?,
                b: r.get(3)?,
                params_b64: B64.encode(r.get::<_, Vec<u8>>(4)?),
                params_digest: r.get(0)?,
                created_at: r.get(5)?,
            })
        },
    )
    .map(Json)
    .map_err(|_| not_found("unknown committee"))
}
