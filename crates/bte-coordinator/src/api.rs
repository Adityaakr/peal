//! REST API (axum, JSON, /v0). See spec/index.md section 6.

use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::db::{now_ms, unix_now};
use crate::scheme::{self, AnyShare, Headers, Sealed};
use crate::state::{new_id, new_share_code, App};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
/// Sealed wire blob cap: framing, points, proof and the payload cap, with
/// headroom (v0 overhead is 73 bytes, v1 is 300).
pub(crate) const MAX_SEALED_BLOB: usize = bte_crypto::MAX_PAYLOAD_BYTES + 4096;

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
        .route("/activity", get(crate::activity::get_activity))
        .route("/x402", get(crate::x402::price))
        .route("/skill-installs", post(crate::activity::skill_installed))
        .route("/healthz", get(|| async { Json(json!({"ok": true})) }))
        .merge(crate::dkg::routes());
    Router::new()
        .nest("/v0", api)
        .nest("/v1", crate::intents::routes())
        .nest("/v1", crate::v1::routes())
        .nest("/v1", crate::auction::routes())
        // The same handlers a second time, behind HTTP 402. Mounted from the
        // same routers rather than reimplemented, so a paid call cannot drift
        // from the free one it is a twin of.
        .nest(
            "/v1/x402",
            crate::v1::routes().merge(crate::auction::routes()).layer(
                axum::middleware::from_fn_with_state(app.clone(), crate::x402::require_payment),
            ),
        )
        // The app shell for a short link, with that auction's own preview meta
        // written into it. Caddy rewrites `/{name}` onto this; the browser's
        // address bar keeps the pretty path. See names.rs.
        .route("/link/{name}", get(crate::names::named_shell))
        .route("/home", get(crate::names::root_shell))
        .route("/crawl/{doc}", get(crate::names::crawler_doc))
        .route("/page/{*path}", get(crate::names::nested_page))
        // Bounded by the one route that carries bulk: a sealed blob arrives
        // base64'd inside JSON, so 4/3 of the blob cap plus slack for the
        // surrounding fields. This is what a request may BUFFER, so it is kept
        // tight to the real maximum rather than left as a loose multiple.
        .layer(DefaultBodyLimit::max(MAX_SEALED_BLOB * 4 / 3 + 64 * 1024))
        .layer(axum::middleware::from_fn_with_state(
            app.clone(),
            rate_limit,
        ))
        // Outside the rate limiter, so a refused request still counts as one
        // that was attempted. A chart that only shows what got through cannot
        // show somebody hitting a wall.
        .layer(axum::middleware::from_fn_with_state(
            app.clone(),
            crate::activity::observe,
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
    // Every header the documentation tells a caller to send.
    //
    // This was `content-type` alone, which meant the quickstart worked from
    // peal.network and from nowhere else: a browser on any other origin had its
    // Idempotency-Key and If-None-Match stripped by the preflight, so the two
    // things this API asks agents to do, retry safely and poll cheaply, were
    // the two a cross origin caller could not do.
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type, accept, idempotency-key, if-none-match, x-payment"),
    );
    // And every header the documentation tells a caller to read. Without this a
    // browser can see the status line and the body and nothing else: the ETag it
    // was told to send back, the Location of what it just made, its rate limit
    // budget and its payment receipt were all invisible.
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(
            "etag, location, ratelimit-limit, ratelimit-remaining, ratelimit-reset, \
             retry-after, x-payment-response",
        ),
    );
    // A preflight for every request is a round trip nobody needs; this API's
    // CORS answer does not change.
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("86400"),
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

    let (allowed, remaining) = {
        let cfg = &app.0.cfg;
        let mut buckets = app.0.buckets.lock().unwrap();
        let now = now_ms();
        let (tokens, last) = buckets.entry(ip).or_insert((cfg.rate_burst, now));
        *tokens = (*tokens + (now - *last) as f64 / 1000.0 * cfg.rate_rps).min(cfg.rate_burst);
        *last = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            (true, *tokens)
        } else {
            (false, 0.0)
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
        let mut res = (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error": "rate limited"})),
        )
            .into_response();
        rate_headers(res.headers_mut(), &app, 0.0);
        return res;
    }
    let mut res = next.run(request).await;
    // On every response, not only the rejections. A client that can only learn
    // its budget by being refused has to be refused to learn it.
    rate_headers(res.headers_mut(), &app, remaining);
    res
}

/// IETF draft ratelimit headers, plus the X- spellings most clients already
/// read. Cheap, and it turns "am I about to be throttled" into a lookup.
fn rate_headers(headers: &mut axum::http::HeaderMap, app: &App, remaining: f64) {
    use axum::http::HeaderValue;
    let limit = app.0.cfg.rate_burst as i64;
    let left = remaining.floor().max(0.0) as i64;
    // Seconds until the bucket is full again at the configured refill rate.
    let reset = if app.0.cfg.rate_rps > 0.0 {
        (((app.0.cfg.rate_burst - remaining).max(0.0)) / app.0.cfg.rate_rps).ceil() as i64
    } else {
        0
    };
    for (name, value) in [
        ("ratelimit-limit", limit),
        ("ratelimit-remaining", left),
        ("ratelimit-reset", reset),
        ("x-ratelimit-limit", limit),
        ("x-ratelimit-remaining", left),
        ("x-ratelimit-reset", reset),
    ] {
        if let Ok(v) = HeaderValue::from_str(&value.to_string()) {
            headers.insert(axum::http::HeaderName::from_static(name), v);
        }
    }
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
                // The tag was missing from this insert, so a block-scheduled
                // condition could never be attributed to the app that made it.
                "INSERT INTO conditions (id, committee_id, kind, chain_id, height, status, tag, created_at)
                 VALUES (?1, ?2, 'at_block', ?3, ?4, 'pending', ?5, ?6)",
                rusqlite::params![id, committee_id, chain_id, height, tag, now],
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
    let ct =
        Sealed::parse(&blob).map_err(|e| bad_request(format!("invalid sealed ciphertext: {e}")))?;
    let ct_hash = hex::encode(ct.hash());

    let conn = app.0.db.lock().unwrap();
    let (status, committee_id): (String, String) = conn
        .query_row(
            "SELECT status, committee_id FROM conditions WHERE id = ?1",
            [&req.condition_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| not_found("unknown condition"))?;
    if status != "pending" {
        return Err(bad_request(format!(
            "condition is {status}; sealing is closed"
        )));
    }
    let committee = app
        .committee(&committee_id)
        .ok_or_else(|| internal("committee not cached"))?;
    admit_ciphertext(&conn, &committee, &ct, &req.condition_id).map_err(bad_request)?;
    conn.execute(
        "INSERT OR IGNORE INTO ciphertexts (ct_hash, condition_id, sealed_blob, is_dummy, created_at, code, kem_point)
         VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6)",
        rusqlite::params![
            ct_hash,
            req.condition_id,
            blob,
            unix_now(),
            new_share_code(),
            ct.kem_point_hex()
        ],
    )
    .map_err(|e| match e {
        rusqlite::Error::SqliteFailure(f, _)
            if f.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            bad_request("a ciphertext with this randomness is already sealed to this condition")
        }
        other => internal(other),
    })?;
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

/// Admission at the door, shared by /v0 and /v1 intake: the scheme matches
/// the committee, a v1 proof verifies and names this condition, and a v1
/// condition has room (one batch, minus the decoy).
pub(crate) fn admit_ciphertext(
    conn: &rusqlite::Connection,
    committee: &scheme::Committee,
    ct: &Sealed,
    condition_id: &str,
) -> Result<(), String> {
    ct.admit(committee, condition_id)?;
    if let Some(capacity) = committee.real_capacity() {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ciphertexts WHERE condition_id = ?1 AND is_dummy = 0",
                [condition_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count as usize >= capacity {
            return Err(format!(
                "condition is full: a v1 condition holds at most {capacity} ciphertexts"
            ));
        }
    }
    Ok(())
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
/// position order (v0: B * 48 bytes; v1: framed 320-byte headers), base64.
/// `scheme` and `committee_id` tell an operator which key to use.
async fn get_work(
    State(app): State<App>,
    Query(q): Query<WorkQuery>,
) -> Result<Json<Value>, ApiError> {
    let conn = app.0.db.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT b.id, b.condition_id, b.batch_index, k.b, k.id, k.scheme
             FROM batches b
             JOIN conditions c ON c.id = b.condition_id
             JOIN committees k ON k.id = c.committee_id
             WHERE b.finalized_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM shares s
                               WHERE s.batch_id = b.id AND s.operator_id = ?1)",
        )
        .map_err(internal)?;
    let batch_rows: Vec<(i64, String, i64, i64, String, String)> = stmt
        .query_map([q.operator], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .map_err(internal)?
        .collect::<Result<_, _>>()
        .map_err(internal)?;

    let mut batches = Vec::new();
    for (batch_id, condition_id, batch_index, b, committee_id, scheme_name) in batch_rows {
        let headers = batch_headers(&conn, &condition_id, batch_index, b)?;
        batches.push(json!({
            "batch_id": batch_id,
            "condition_id": condition_id,
            "committee_id": committee_id,
            "scheme": scheme_name,
            "b": b,
            "slots": headers.len(),
            "headers_b64": B64.encode(headers.pack()),
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
    let share = AnyShare::parse(&blob).map_err(|e| bad_request(format!("invalid share: {e}")))?;
    if share.party_index() != req.operator_id {
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
        let headers = batch_headers(&conn, &condition_id, batch_index, b)?;
        (condition_id, committee_id, headers)
    };

    let committee = app
        .committee(&committee_id)
        .ok_or_else(|| internal("committee not cached"))?;
    let verified =
        tokio::task::spawn_blocking(move || scheme::verify_share(&committee, &headers, &share))
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
            "slots": headers.len(),
            "headers_b64": B64.encode(headers.pack()),
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

/// The batch's ciphertext headers in position order.
fn batch_headers(
    conn: &rusqlite::Connection,
    condition_id: &str,
    batch_index: i64,
    b: i64,
) -> Result<Headers, ApiError> {
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
    let cts: Vec<Sealed> = blobs
        .iter()
        .map(|blob| Sealed::parse(blob))
        .collect::<Result<_, _>>()
        .map_err(internal)?;
    Headers::of(&cts).map_err(internal)
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
        .prepare("SELECT id, n, t, b, created_at, scheme FROM committees ORDER BY created_at DESC")
        .map_err(internal)?;
    let rows: Vec<Value> = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "n": r.get::<_, i64>(1)?,
                "t": r.get::<_, i64>(2)?,
                "b": r.get::<_, i64>(3)?,
                "created_at": r.get::<_, i64>(4)?,
                "scheme": r.get::<_, String>(5)?,
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
    /// "v0" (simple-bte, dealer-trusted, fixed batch) or "v1" (transparent
    /// setup from a DKG, no batch bound).
    scheme: String,
    n: i64,
    t: i64,
    /// v0: the fixed batch size. v1: the batch stride (one batch per
    /// condition, at most b - 1 ciphertexts plus one decoy).
    b: i64,
    params_b64: String,
    params_digest: String,
    /// v1: hex of the DKG output digest the key came from. Absent for v0.
    setup_digest: Option<String>,
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
    let setup_digest = app.committee(&resolved).and_then(|c| match c.scheme {
        scheme::Scheme::V1 => Some(hex::encode(c.setup_digest)),
        scheme::Scheme::V0 => None,
    });
    let conn = app.0.db.lock().unwrap();
    conn.query_row(
        "SELECT id, n, t, b, params_blob, created_at, scheme FROM committees WHERE id = ?1",
        [&resolved],
        |r| {
            Ok(CommitteeDetail {
                id: r.get(0)?,
                scheme: r.get(6)?,
                n: r.get(1)?,
                t: r.get(2)?,
                b: r.get(3)?,
                params_b64: B64.encode(r.get::<_, Vec<u8>>(4)?),
                params_digest: r.get(0)?,
                setup_digest,
                created_at: r.get(5)?,
            })
        },
    )
    .map(Json)
    .map_err(|_| not_found("unknown committee"))
}
