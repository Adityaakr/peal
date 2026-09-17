//! HTTP surface of the node, under `/links/v1`.
//!
//! Every handler decodes strictly, delegates value decisions to the ledger
//! actor (the STF), and answers problem+json on failure. Nothing here can
//! move funds without a proof the ledger verified.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use peal_bonsai::account::{InboxAuth, KeyBinding, Namespace, OpEnvelope, RegisterEnvelope};
use peal_bonsai::deposit::{DepositIntent, MintEnvelope};
use peal_bonsai::encoding::{fr_from_hex, fr_to_hex};
use peal_bonsai::manifest::{FulfillmentAck, RequestManifest};
use peal_bonsai::Fr;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::{NamespaceConfig, NodeConfig};
use crate::ledger_actor::LedgerHandle;
use crate::problem::Problem;
use crate::product;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const NONCE_TTL: u64 = 600;
const INBOX_AUTH_WINDOW: u64 = 120;
const MAX_INBOX_ENVELOPE_JSON: usize = 8 * 1024;
const RESERVE_SECS: u64 = 10 * 60;

pub struct ParamFile {
    pub bytes: Vec<u8>,
    pub digest: String,
}

pub struct AppState {
    pub cfg: NodeConfig,
    pub circuit_id: [u8; 32],
    pub ledgers: HashMap<Namespace, LedgerHandle>,
    pub namespaces: HashMap<Namespace, NamespaceConfig>,
    pub params: HashMap<&'static str, ParamFile>,
    pub product: Mutex<rusqlite::Connection>,
    /// Set by the watcher once a namespace's chain configuration has been
    /// verified against the chain. Never true for a disabled namespace.
    pub availability: Mutex<HashMap<Namespace, bool>>,
    /// The settlement committee (a local fixture or one key per
    /// validator), if any.
    pub committee: Option<crate::settlement::Committee>,
    /// Validator mode: the consensus handle (decision 0010).
    pub consensus: Option<peal_links_consensus::Handle>,
    /// Directory lookups per session per minute (decision 0013).
    pub directory_limits: Mutex<crate::directory::RateLimiter>,
}

impl AppState {
    pub fn available(&self, ns: &Namespace) -> bool {
        *self
            .availability
            .lock()
            .expect("availability lock")
            .get(ns)
            .unwrap_or(&false)
    }
}

pub type App = Arc<AppState>;

type Res<T> = Result<T, Problem>;

fn db<T>(r: rusqlite::Result<T>) -> Res<T> {
    r.map_err(|e| Problem::internal(e.to_string()))
}

fn anyhow<T>(r: anyhow::Result<T>) -> Res<T> {
    r.map_err(|e| Problem::internal(e.to_string()))
}

fn parse_ns(app: &AppState, ns: &str) -> Res<Namespace> {
    let bytes =
        hex::decode(ns).map_err(|_| Problem::bad_request("malformed", "namespace must be hex"))?;
    let id: Namespace = bytes
        .try_into()
        .map_err(|_| Problem::bad_request("malformed", "namespace must be 32 bytes"))?;
    if !app.ledgers.contains_key(&id) {
        return Err(Problem::not_found(
            "unknown_namespace",
            "no such namespace on this node",
        ));
    }
    Ok(id)
}

fn parse_fr(s: &str) -> Res<Fr> {
    fr_from_hex(s).map_err(Problem::from)
}

fn ledger<'a>(app: &'a AppState, ns: &Namespace) -> &'a LedgerHandle {
    app.ledgers.get(ns).expect("parse_ns checked")
}

// ---- status and params ---------------------------------------------------

#[derive(Serialize)]
struct NamespaceOut {
    id: String,
    label: String,
    chain_id: u64,
    chain_name: String,
    token_symbol: String,
    token_address: String,
    decimals: u8,
    gateway: String,
    available: bool,
    confirmations: u64,
    environment: String,
    explorer_url: String,
    /// The chain's public RPC, so a client can read the chain (and, on
    /// chains that offer one, call the gas faucet) without a wallet.
    rpc_url: String,
}

fn namespace_out(app: &AppState, ns: &NamespaceConfig) -> NamespaceOut {
    NamespaceOut {
        id: hex::encode(ns.id()),
        label: ns.label.clone(),
        chain_id: ns.chain_id,
        chain_name: ns.chain_name.clone(),
        token_symbol: ns.token_symbol.clone(),
        token_address: ns.token_address.clone(),
        decimals: ns.decimals,
        gateway: ns.gateway.clone(),
        available: ns.enabled && app.available(&ns.id()),
        confirmations: ns.confirmations,
        environment: ns.environment.clone(),
        explorer_url: ns.explorer_url.clone(),
        rpc_url: ns.rpc_url.clone(),
    }
}

async fn status(State(app): State<App>) -> Res<Json<Value>> {
    let mut ledgers = Vec::new();
    for ns in &app.cfg.namespaces {
        let s = ledger(&app, &ns.id()).summary().await;
        ledgers.push(json!({
            "namespace": s.namespace,
            "seq": s.seq,
            "receipt_count": s.receipt_count,
            "state_root": s.state_root,
            "receipt_root": s.receipt_root,
        }));
    }
    Ok(Json(json!({
        "ok": true,
        "version": VERSION,
        "circuit_id": hex::encode(app.circuit_id),
        "setup": "local-dev",
        "ledger_mode": match &app.consensus {
            Some(h) => format!("simplex-{}-validators", h.validators.len()),
            None => "single-node".to_string(),
        },
        "consensus": consensus_status(&app).await,
        "dev_mint": app.cfg.dev_mint,
        "signer_mode": app.committee.as_ref().map(|c| c.mode()).unwrap_or("none"),
        "signers": app.committee.as_ref().map(|c| c.addresses()).unwrap_or_default(),
        "signer_threshold": app.committee.as_ref().map(|c| c.threshold()).unwrap_or(0),
        "namespaces": app.cfg.namespaces.iter().map(|n| namespace_out(&app, n)).collect::<Vec<_>>(),
        "ledgers": ledgers,
    })))
}

/// What this validator reports about consensus, or null in single-node mode.
async fn consensus_status(app: &AppState) -> Value {
    match &app.consensus {
        None => Value::Null,
        Some(h) => match h.status().await {
            Some(s) => serde_json::to_value(s).unwrap_or(Value::Null),
            None => json!({ "error": "consensus actor not answering" }),
        },
    }
}

/// `GET /links/v1/consensus`: this validator's view (height, head digest,
/// applied state root, mempool) plus every ledger's summary, so two
/// validators can be compared byte for byte.
async fn consensus_view(State(app): State<App>) -> Res<Json<Value>> {
    let Some(h) = &app.consensus else {
        return Err(Problem::not_found(
            "single_node",
            "this node runs the single-node ledger",
        ));
    };
    let status = h
        .status()
        .await
        .ok_or_else(|| Problem::internal("consensus actor not answering".to_string()))?;
    let mut ledgers = Vec::new();
    for ns in &app.cfg.namespaces {
        ledgers.push(
            serde_json::to_value(ledger(&app, &ns.id()).summary().await).expect("serializes"),
        );
    }
    Ok(Json(json!({
        "validator": status.validator,
        "validators": status.validators,
        "height": status.height,
        "head": status.head,
        "state_root": status.state_root,
        "genesis": status.genesis,
        "mempool": status.mempool,
        "finalized_seen": status.finalized_seen,
        "last_finalized_view": status.last_finalized_view,
        "pending_finalized": status.pending_finalized,
        "ledgers": ledgers,
    })))
}

async fn params_index(State(app): State<App>) -> Json<Value> {
    let files: serde_json::Map<String, Value> = app
        .params
        .iter()
        .map(|(name, f)| {
            (
                (*name).to_string(),
                json!({ "digest": f.digest, "size": f.bytes.len() }),
            )
        })
        .collect();
    Json(json!({
        "circuit_id": hex::encode(app.circuit_id),
        "setup": "local-dev",
        "files": files,
    }))
}

async fn params_file(
    State(app): State<App>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(file) = app.params.get(name.as_str()) else {
        return Problem::not_found("unknown_param", "no such parameter file").into_response();
    };
    let etag = format!("\"{}\"", file.digest);
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(etag.as_str())
    {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    (
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::ETAG, etag),
            (
                header::CACHE_CONTROL,
                "public, max-age=31536000, immutable".to_string(),
            ),
            (
                header::HeaderName::from_static("x-peal-digest"),
                file.digest.clone(),
            ),
        ],
        file.bytes.clone(),
    )
        .into_response()
}

// ---- ledger ----------------------------------------------------------------

async fn ledger_summary(State(app): State<App>, Path(ns): Path<String>) -> Res<Json<Value>> {
    let id = parse_ns(&app, &ns)?;
    let s = ledger(&app, &id).summary().await;
    Ok(Json(serde_json::to_value(s).expect("serializes")))
}

async fn ledger_account(
    State(app): State<App>,
    Path((ns, acct)): Path<(String, String)>,
) -> Res<Json<Value>> {
    let id = parse_ns(&app, &ns)?;
    let account = parse_fr(&acct)?;
    match ledger(&app, &id).account(account).await? {
        Some(a) => Ok(Json(json!({
            "account": fr_to_hex(&a.account),
            "com": fr_to_hex(&a.com),
            "updated_seq": a.updated_seq,
        }))),
        None => Err(Problem::not_found(
            "unknown_account",
            "account is not registered",
        )),
    }
}

fn applied_json(a: peal_bonsai::ledger::Applied) -> Value {
    json!({
        "seq": a.seq,
        "position": if a.position == u64::MAX { Value::Null } else { json!(a.position) },
        "receipt_root": fr_to_hex(&a.receipt_root),
        "state_root": hex::encode(a.state_root),
    })
}

async fn ledger_register(
    State(app): State<App>,
    Path(ns): Path<String>,
    Json(env): Json<RegisterEnvelope>,
) -> Res<Json<Value>> {
    let id = parse_ns(&app, &ns)?;
    if env.namespace != id {
        return Err(Problem::bad_request(
            "wrong_namespace",
            "envelope names another namespace",
        ));
    }
    Ok(Json(applied_json(ledger(&app, &id).register(env).await?)))
}

async fn ledger_apply(
    State(app): State<App>,
    Path(ns): Path<String>,
    Json(env): Json<OpEnvelope>,
) -> Res<Json<Value>> {
    let id = parse_ns(&app, &ns)?;
    if env.namespace != id {
        return Err(Problem::bad_request(
            "wrong_namespace",
            "envelope names another namespace",
        ));
    }
    if env.proof.len() != peal_bonsai::encoding::PROOF_BYTES {
        return Err(Problem::bad_request("malformed", "proof must be 128 bytes"));
    }
    Ok(Json(applied_json(ledger(&app, &id).apply(env).await?)))
}

#[derive(Deserialize)]
struct PathQuery {
    size: Option<u64>,
}

async fn ledger_path(
    State(app): State<App>,
    Path((ns, pos)): Path<(String, u64)>,
    Query(q): Query<PathQuery>,
) -> Res<Json<Value>> {
    let id = parse_ns(&app, &ns)?;
    let p = ledger(&app, &id).path(pos, q.size).await?;
    Ok(Json(serde_json::to_value(p).expect("serializes")))
}

#[derive(Deserialize)]
struct HistoryQuery {
    from: Option<u64>,
    limit: Option<usize>,
}

async fn ledger_history(
    State(app): State<App>,
    Path(ns): Path<String>,
    Query(q): Query<HistoryQuery>,
) -> Res<Json<Value>> {
    let id = parse_ns(&app, &ns)?;
    let rows = ledger(&app, &id)
        .history(q.from.unwrap_or(1), q.limit.unwrap_or(100))
        .await?;
    let out: Vec<Value> = rows
        .into_iter()
        .map(|(seq, kind, env, pos)| {
            json!({ "seq": seq, "kind": kind, "envelope": serde_json::from_str::<Value>(&env).unwrap_or(Value::Null), "position": pos })
        })
        .collect();
    Ok(Json(json!({ "ops": out })))
}

// ---- auth -----------------------------------------------------------------

async fn auth_nonce(State(app): State<App>) -> Res<Json<Value>> {
    let conn = app.product.lock().expect("product lock");
    let (nonce, expires) = anyhow(product::issue_nonce(&conn, NONCE_TTL))?;
    Ok(Json(json!({ "nonce": nonce, "expires_at": expires })))
}

#[derive(Deserialize)]
struct SessionIn {
    message: String,
    signature: String,
}

async fn auth_session(State(app): State<App>, Json(body): Json<SessionIn>) -> Res<Json<Value>> {
    if body.message.len() > 4096 {
        return Err(Problem::bad_request("malformed", "message too long"));
    }
    let siwe = crate::auth::parse(&body.message)
        .map_err(|e| Problem::bad_request("bad_siwe", format!("sign-in message: {e}")))?;
    if !app.cfg.auth_domains.iter().any(|d| d == &siwe.domain) {
        return Err(Problem::unauthorized(
            "sign-in message is for another domain",
        ));
    }
    let now = product::now();
    let issued = crate::auth::parse_rfc3339(&siwe.issued_at)
        .ok_or_else(|| Problem::bad_request("bad_siwe", "issued at"))?;
    if issued > now + 120 || now > issued + NONCE_TTL {
        return Err(Problem::unauthorized("sign-in message is not fresh"));
    }
    if let Some(exp) = &siwe.expiration_time {
        let exp = crate::auth::parse_rfc3339(exp)
            .ok_or_else(|| Problem::bad_request("bad_siwe", "expiration time"))?;
        if exp <= now {
            return Err(Problem::unauthorized("sign-in message has expired"));
        }
    }
    let recovered = crate::auth::recover(
        &crate::auth::personal_digest(&body.message),
        &body.signature,
    )
    .map_err(|e| Problem::unauthorized(format!("signature: {e}")))?;
    if recovered != siwe.address.to_lowercase() {
        // A contract wallet would land here too: its signature does not
        // recover to its address. ERC-1271 is not supported by this node.
        return Err(Problem::unauthorized(
            "signature does not recover to the address (contract wallets are not supported)",
        ));
    }
    let conn = app.product.lock().expect("product lock");
    if !anyhow(product::consume_nonce(&conn, &siwe.nonce))? {
        return Err(Problem::unauthorized(
            "nonce is unknown, expired or already used",
        ));
    }
    let (token, expires) = anyhow(product::create_session(
        &conn,
        &recovered,
        siwe.chain_id,
        app.cfg.session_ttl_secs,
    ))?;
    Ok(Json(
        json!({ "token": token, "address": recovered, "expires_at": expires }),
    ))
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(|s| s.trim().to_string())
}

fn require_session(app: &AppState, headers: &HeaderMap) -> Res<product::Session> {
    let token = bearer(headers).ok_or_else(|| Problem::unauthorized("sign in first"))?;
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Problem::unauthorized("bad session token"));
    }
    let conn = app.product.lock().expect("product lock");
    anyhow(product::session(&conn, &token))?
        .ok_or_else(|| Problem::unauthorized("session expired; sign in again"))
}

async fn auth_me(State(app): State<App>, headers: HeaderMap) -> Res<Json<Value>> {
    let s = require_session(&app, &headers)?;
    Ok(Json(
        json!({ "address": s.address, "chain_id": s.chain_id }),
    ))
}

// ---- requests -------------------------------------------------------------

#[derive(Serialize)]
struct RequestOut {
    manifest: RequestManifest,
    status: String,
    fulfilled_at: Option<u64>,
    reserved: bool,
}

type RequestRow = (String, String, Option<i64>, Option<i64>, Option<String>);

const REQUEST_COLS: &str = "manifest, status, fulfilled_at, reserved_until, reserved_by";

fn request_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RequestRow> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
}

fn request_out(
    manifest_json: &str,
    status: &str,
    fulfilled_at: Option<i64>,
    reserved_until: Option<i64>,
    reserved_by: Option<String>,
    caller_intent: Option<&str>,
) -> Res<RequestOut> {
    let manifest: RequestManifest = serde_json::from_str(manifest_json)
        .map_err(|e| Problem::internal(format!("stored manifest: {e}")))?;
    let now = product::now();
    let expired = manifest.expires_at.is_some_and(|e| e <= now);
    let status = if status == "active" && expired {
        "expired"
    } else {
        status
    };
    let held = status == "active" && reserved_until.is_some_and(|u| u as u64 > now);
    let mine = caller_intent.is_some() && reserved_by.as_deref() == caller_intent;
    let reserved = held && !mine;
    Ok(RequestOut {
        manifest,
        status: status.to_string(),
        fulfilled_at: fulfilled_at.map(|t| t as u64),
        reserved,
    })
}

async fn create_request(
    State(app): State<App>,
    headers: HeaderMap,
    Json(m): Json<RequestManifest>,
) -> Res<(StatusCode, Json<Value>)> {
    let session = require_session(&app, &headers)?;
    m.verify()
        .map_err(|e| Problem::bad_request("bad_manifest", e.to_string()))?;
    if !app.ledgers.contains_key(&m.namespace) {
        return Err(Problem::bad_request(
            "unknown_namespace",
            "manifest names a namespace this node does not serve",
        ));
    }
    let now = product::now();
    if m.created_at > now + 300 || m.created_at + 3600 < now {
        return Err(Problem::bad_request(
            "bad_manifest",
            "created_at must be close to now",
        ));
    }
    if let Some(exp) = m.expires_at {
        if exp <= now {
            return Err(Problem::bad_request("bad_manifest", "already expired"));
        }
    }
    // The receiving account must exist on the ledger, otherwise a payer
    // would pay into an account nobody can open.
    if ledger(&app, &m.namespace)
        .account(m.receiver_account)
        .await?
        .is_none()
    {
        return Err(Problem::bad_request(
            "unregistered_receiver",
            "the receiving account is not registered on the ledger",
        ));
    }
    let json = serde_json::to_string(&m).expect("serializes");
    let conn = app.product.lock().expect("product lock");
    // Idempotent on the request id: the same signed manifest again is the
    // same request; a different manifest under the same id is a conflict.
    let existing: Option<String> = db(conn
        .query_row(
            "SELECT manifest FROM requests WHERE request_id = ?1",
            params![m.request_id],
            |r| r.get(0),
        )
        .optional())?;
    if let Some(existing) = existing {
        if existing == json {
            let (mj, st, fa, ru, rb) = db(conn.query_row(
                &format!("SELECT {REQUEST_COLS} FROM requests WHERE request_id = ?1"),
                params![m.request_id],
                request_row,
            ))?;
            return Ok((
                StatusCode::OK,
                Json(
                    serde_json::to_value(request_out(&mj, &st, fa, ru, rb, None)?)
                        .expect("serializes"),
                ),
            ));
        }
        return Err(Problem::conflict(
            "request_exists",
            "a different request already uses this id",
        ));
    }
    db(conn.execute(
        "INSERT INTO requests (request_id, namespace, owner_address, receiver, manifest, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6)",
        params![m.request_id, hex::encode(m.namespace), session.address, fr_to_hex(&m.receiver_account), json, now as i64],
    ))?;
    let out = RequestOut {
        manifest: m,
        status: "active".into(),
        fulfilled_at: None,
        reserved: false,
    };
    Ok((
        StatusCode::CREATED,
        Json(serde_json::to_value(out).expect("serializes")),
    ))
}

async fn list_requests(State(app): State<App>, headers: HeaderMap) -> Res<Json<Value>> {
    let session = require_session(&app, &headers)?;
    let conn = app.product.lock().expect("product lock");
    let mut stmt = db(conn.prepare(&format!(
        "SELECT {REQUEST_COLS} FROM requests WHERE owner_address = ?1 ORDER BY created_at DESC LIMIT 500"
    )))?;
    let rows = db(stmt.query_map(params![session.address], request_row))?;
    let mut out = Vec::new();
    for row in rows {
        let (mj, st, fa, ru, rb) = db(row)?;
        out.push(request_out(&mj, &st, fa, ru, rb, None)?);
    }
    Ok(Json(json!({ "requests": out })))
}

fn check_request_id(id: &str) -> Res<()> {
    if peal_bonsai::manifest::is_request_id(id) {
        Ok(())
    } else {
        Err(Problem::not_found("unknown_request", "not a request id"))
    }
}

#[derive(Deserialize)]
struct GetRequestQuery {
    /// The caller's payer intent id, so its own reservation is not reported
    /// as someone else's.
    intent: Option<String>,
}

async fn get_request(
    State(app): State<App>,
    Path(id): Path<String>,
    Query(q): Query<GetRequestQuery>,
) -> Res<Json<Value>> {
    check_request_id(&id)?;
    let conn = app.product.lock().expect("product lock");
    let row = db(conn
        .query_row(
            &format!("SELECT {REQUEST_COLS} FROM requests WHERE request_id = ?1"),
            params![id],
            request_row,
        )
        .optional())?;
    let (mj, st, fa, ru, rb) =
        row.ok_or_else(|| Problem::not_found("unknown_request", "no such request"))?;
    Ok(Json(
        serde_json::to_value(request_out(&mj, &st, fa, ru, rb, q.intent.as_deref())?)
            .expect("serializes"),
    ))
}

async fn archive_request(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Res<Json<Value>> {
    let session = require_session(&app, &headers)?;
    check_request_id(&id)?;
    let conn = app.product.lock().expect("product lock");
    let n = db(conn.execute(
        "UPDATE requests SET status = 'archived', updated_at = ?3 WHERE request_id = ?1 AND owner_address = ?2 AND status = 'active'",
        params![id, session.address, product::now() as i64],
    ))?;
    if n == 0 {
        return Err(Problem::not_found(
            "unknown_request",
            "no active request of yours with this id",
        ));
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ReserveIn {
    /// The payer's intent id, so a reload by the same payer keeps its
    /// reservation instead of colliding with itself.
    intent_id: String,
}

/// Soft lock while a payer is at checkout. Documented weaker behaviour: the
/// ledger does not enforce one payment per request, so two payers who both
/// get past this see the second payment land as extra funds for the
/// receiver, who must refund it separately (SPEC section 8).
async fn reserve_request(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(body): Json<ReserveIn>,
) -> Res<Json<Value>> {
    check_request_id(&id)?;
    if body.intent_id.len() < 8 || body.intent_id.len() > 64 {
        return Err(Problem::bad_request("malformed", "intent id"));
    }
    let now = product::now();
    let conn = app.product.lock().expect("product lock");
    let row: Option<(String, Option<String>, Option<i64>, String)> = db(conn
        .query_row(
            "SELECT status, reserved_by, reserved_until, manifest FROM requests WHERE request_id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional())?;
    let (status, by, until, mj) =
        row.ok_or_else(|| Problem::not_found("unknown_request", "no such request"))?;
    let m: RequestManifest =
        serde_json::from_str(&mj).map_err(|e| Problem::internal(e.to_string()))?;
    if status != "active" || m.expires_at.is_some_and(|e| e <= now) {
        return Err(Problem::conflict(
            "not_payable",
            format!("request is {status}"),
        ));
    }
    let held_by_other =
        by.as_deref().is_some_and(|b| b != body.intent_id) && until.is_some_and(|u| u as u64 > now);
    if held_by_other {
        return Err(Problem::conflict(
            "reserved",
            "another payer is completing this request; try again in a few minutes",
        ));
    }
    db(conn.execute(
        "UPDATE requests SET reserved_by = ?2, reserved_until = ?3, updated_at = ?4 WHERE request_id = ?1",
        params![id, body.intent_id, (now + RESERVE_SECS) as i64, now as i64],
    ))?;
    Ok(Json(json!({ "reserved_until": now + RESERVE_SECS })))
}

async fn fulfill_request(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(ack): Json<FulfillmentAck>,
) -> Res<Json<Value>> {
    check_request_id(&id)?;
    if ack.request_id != id {
        return Err(Problem::bad_request(
            "malformed",
            "ack is for another request",
        ));
    }
    ack.verify()
        .map_err(|e| Problem::unauthorized(e.to_string()))?;
    let conn = app.product.lock().expect("product lock");
    let receiver: Option<String> = db(conn
        .query_row(
            "SELECT receiver FROM requests WHERE request_id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional())?;
    let receiver =
        receiver.ok_or_else(|| Problem::not_found("unknown_request", "no such request"))?;
    if receiver != fr_to_hex(&ack.receiver_account) {
        return Err(Problem::unauthorized(
            "ack is not signed by this request's receiver",
        ));
    }
    db(conn.execute(
        "UPDATE requests SET status = 'fulfilled', fulfilled_at = ?2, ack = ?3, updated_at = ?4 WHERE request_id = ?1",
        params![id, ack.claimed_at as i64, serde_json::to_string(&ack).expect("serializes"), product::now() as i64],
    ))?;
    Ok(Json(json!({ "ok": true })))
}

// ---- inbox ----------------------------------------------------------------

async fn bind_key(State(app): State<App>, Json(b): Json<KeyBinding>) -> Res<Json<Value>> {
    if !app.ledgers.contains_key(&b.namespace) {
        return Err(Problem::bad_request(
            "unknown_namespace",
            "no such namespace",
        ));
    }
    b.verify()
        .map_err(|e| Problem::unauthorized(e.to_string()))?;
    let conn = app.product.lock().expect("product lock");
    let current: Option<i64> = db(conn
        .query_row(
            "SELECT seq FROM inbox_keys WHERE namespace = ?1 AND account = ?2",
            params![hex::encode(b.namespace), fr_to_hex(&b.account)],
            |r| r.get(0),
        )
        .optional())?;
    if current.is_some_and(|s| s as u64 >= b.seq) {
        return Err(Problem::conflict(
            "stale_binding",
            "a binding with an equal or higher sequence exists",
        ));
    }
    db(conn.execute(
        "INSERT INTO inbox_keys (namespace, account, binding, seq) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(namespace, account) DO UPDATE SET binding = excluded.binding, seq = excluded.seq",
        params![hex::encode(b.namespace), fr_to_hex(&b.account), serde_json::to_string(&b).expect("serializes"), b.seq as i64],
    ))?;
    Ok(Json(json!({ "ok": true })))
}

async fn get_key(
    State(app): State<App>,
    Path((ns, acct)): Path<(String, String)>,
) -> Res<Json<Value>> {
    let id = parse_ns(&app, &ns)?;
    let account = parse_fr(&acct)?;
    let conn = app.product.lock().expect("product lock");
    let row: Option<String> = db(conn
        .query_row(
            "SELECT binding FROM inbox_keys WHERE namespace = ?1 AND account = ?2",
            params![hex::encode(id), fr_to_hex(&account)],
            |r| r.get(0),
        )
        .optional())?;
    let json = row.ok_or_else(|| {
        Problem::not_found("no_key", "this account has not published an encryption key")
    })?;
    Ok(Json(
        serde_json::from_str(&json).map_err(|e| Problem::internal(e.to_string()))?,
    ))
}

#[derive(Deserialize)]
struct InboxPost {
    envelope: peal_bonsai::envelope::ReceiptEnvelope,
    request_id: Option<String>,
}

async fn post_inbox(
    State(app): State<App>,
    Path((ns, acct)): Path<(String, String)>,
    body: Bytes,
) -> Res<(StatusCode, Json<Value>)> {
    let id = parse_ns(&app, &ns)?;
    let account = parse_fr(&acct)?;
    if body.len() > MAX_INBOX_ENVELOPE_JSON {
        return Err(Problem::bad_request("too_large", "envelope too large"));
    }
    let post: InboxPost = serde_json::from_slice(&body)
        .map_err(|e| Problem::bad_request("malformed", e.to_string()))?;
    if post.envelope.namespace != id {
        return Err(Problem::bad_request(
            "wrong_namespace",
            "envelope names another namespace",
        ));
    }
    if post.envelope.nonce.len() != 24 || post.envelope.ciphertext.len() < 16 {
        return Err(Problem::bad_request("malformed", "envelope shape"));
    }
    if let Some(r) = &post.request_id {
        check_request_id(r)?;
    }
    // The account must exist on the ledger: an inbox for nobody is spam.
    if ledger(&app, &id).account(account).await?.is_none() {
        return Err(Problem::not_found(
            "unknown_account",
            "account is not registered",
        ));
    }
    let conn = app.product.lock().expect("product lock");
    db(conn.execute(
        "INSERT INTO inbox (namespace, account, envelope, request_id, posted_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![hex::encode(id), fr_to_hex(&account), serde_json::to_string(&post.envelope).expect("serializes"), post.request_id, product::now() as i64],
    ))?;
    let row_id = conn.last_insert_rowid();
    Ok((StatusCode::CREATED, Json(json!({ "id": row_id }))))
}

#[derive(Deserialize)]
struct InboxQuery {
    after: Option<i64>,
}

async fn get_inbox(
    State(app): State<App>,
    Path((ns, acct)): Path<(String, String)>,
    Query(q): Query<InboxQuery>,
    headers: HeaderMap,
) -> Res<Json<Value>> {
    let id = parse_ns(&app, &ns)?;
    let account = parse_fr(&acct)?;
    let auth_header = headers
        .get("x-peal-inbox-auth")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| Problem::unauthorized("inbox auth header required"))?;
    let auth: InboxAuth =
        serde_json::from_str(auth_header).map_err(|_| Problem::unauthorized("bad inbox auth"))?;
    if auth.namespace != id || auth.account != account {
        return Err(Problem::unauthorized("inbox auth is for another inbox"));
    }
    auth.verify(product::now(), INBOX_AUTH_WINDOW)
        .map_err(|e| Problem::unauthorized(e.to_string()))?;
    let conn = app.product.lock().expect("product lock");
    let mut stmt = db(conn.prepare(
        "SELECT id, envelope, request_id, posted_at FROM inbox WHERE namespace = ?1 AND account = ?2 AND id > ?3 ORDER BY id ASC LIMIT 200",
    ))?;
    let rows = db(stmt.query_map(
        params![hex::encode(id), fr_to_hex(&account), q.after.unwrap_or(0)],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, i64>(3)?,
            ))
        },
    ))?;
    let mut out = Vec::new();
    for row in rows {
        let (rid, env, req, at) = db(row)?;
        out.push(json!({ "id": rid, "envelope": serde_json::from_str::<Value>(&env).unwrap_or(Value::Null), "request_id": req, "posted_at": at }));
    }
    Ok(Json(json!({ "items": out })))
}

// ---- deposits -------------------------------------------------------------

async fn register_intent(
    State(app): State<App>,
    Json(intent): Json<DepositIntent>,
) -> Res<(StatusCode, Json<Value>)> {
    if !app.ledgers.contains_key(&intent.namespace) {
        return Err(Problem::bad_request(
            "unknown_namespace",
            "no such namespace",
        ));
    }
    if intent.circuit_id != app.circuit_id {
        return Err(Problem::bad_request(
            "wrong_circuit",
            "intent is for another circuit",
        ));
    }
    if intent.amount == 0 {
        return Err(Problem::bad_request("malformed", "amount must be positive"));
    }
    // Verify the deposit proof now so a bad intent is refused at
    // registration rather than discovered when the chain event arrives.
    let proof = peal_bonsai::encoding::proof_from_bytes(&intent.proof)?;
    let vk = &app
        .params
        .get("deposit.vk")
        .map(|f| peal_bonsai::params::vk_from_bytes(&f.bytes))
        .transpose()?
        .ok_or_else(|| Problem::internal("deposit vk missing"))?;
    let input =
        peal_bonsai::deposit::DepositCircuit::public_input_for(intent.amount, intent.receipt);
    if !zkpari_verify(&proof, vk, &input) {
        return Err(Problem::from(peal_bonsai::Error::InvalidProof));
    }
    let conn = app.product.lock().expect("product lock");
    let existing: Option<String> = db(conn
        .query_row(
            "SELECT status FROM deposit_intents WHERE namespace = ?1 AND receipt = ?2",
            params![hex::encode(intent.namespace), fr_to_hex(&intent.receipt)],
            |r| r.get(0),
        )
        .optional())?;
    if let Some(status) = existing {
        return Ok((
            StatusCode::OK,
            Json(json!({ "receipt": fr_to_hex(&intent.receipt), "status": status })),
        ));
    }
    db(conn.execute(
        "INSERT INTO deposit_intents (namespace, receipt, intent, status, created_at) VALUES (?1, ?2, ?3, 'pending', ?4)",
        params![hex::encode(intent.namespace), fr_to_hex(&intent.receipt), serde_json::to_string(&intent).expect("serializes"), product::now() as i64],
    ))?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "receipt": fr_to_hex(&intent.receipt), "status": "pending" })),
    ))
}

fn zkpari_verify(
    proof: &zkpari::Proof<peal_bonsai::E>,
    vk: &zkpari::VerifyingKey<peal_bonsai::E>,
    input: &[Fr],
) -> bool {
    zkpari::ZkPari::<peal_bonsai::E>::verify(proof, vk, input)
}

async fn get_intent(
    State(app): State<App>,
    Path((ns, receipt)): Path<(String, String)>,
) -> Res<Json<Value>> {
    let id = parse_ns(&app, &ns)?;
    let r = parse_fr(&receipt)?;
    let conn = app.product.lock().expect("product lock");
    let row: Option<(String, Option<String>, Option<i64>)> = db(conn
        .query_row(
            "SELECT status, deposit_id, position FROM deposit_intents WHERE namespace = ?1 AND receipt = ?2",
            params![hex::encode(id), fr_to_hex(&r)],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional())?;
    let (status, deposit_id, position) =
        row.ok_or_else(|| Problem::not_found("unknown_intent", "no such deposit intent"))?;
    Ok(Json(
        json!({ "receipt": fr_to_hex(&r), "status": status, "deposit_id": deposit_id, "position": position }),
    ))
}

/// Credit a registered intent as a mint. Used by the watcher (Phase D) with
/// a real event identity, and by the labelled development endpoint below.
pub async fn credit_intent(
    app: &AppState,
    ns: Namespace,
    receipt: Fr,
    deposit_id: String,
) -> Res<Value> {
    let intent: DepositIntent = {
        let conn = app.product.lock().expect("product lock");
        let row: Option<(String, String)> = db(conn
            .query_row(
                "SELECT intent, status FROM deposit_intents WHERE namespace = ?1 AND receipt = ?2",
                params![hex::encode(ns), fr_to_hex(&receipt)],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional())?;
        let (json, status) = row.ok_or_else(|| {
            Problem::not_found("unknown_intent", "no registered intent for this receipt")
        })?;
        if status != "pending" {
            return Err(Problem::conflict(
                "already_minted",
                "this intent was already credited",
            ));
        }
        serde_json::from_str(&json).map_err(|e| Problem::internal(e.to_string()))?
    };
    let applied = ledger(app, &ns)
        .mint(MintEnvelope {
            intent,
            deposit_id: deposit_id.clone(),
        })
        .await?;
    let conn = app.product.lock().expect("product lock");
    db(conn.execute(
        "UPDATE deposit_intents SET status = 'minted', deposit_id = ?3, position = ?4 WHERE namespace = ?1 AND receipt = ?2",
        params![hex::encode(ns), fr_to_hex(&receipt), deposit_id, applied.position as i64],
    ))?;
    Ok(applied_json(applied))
}

// ---- directory and backups (decisions 0011 to 0013) ------------------------

const DIRECTORY_LOOKUPS_PER_MINUTE: u32 = 60;

/// Publish a signed receiving profile for the signed-in wallet.
async fn put_profile(
    State(app): State<App>,
    headers: HeaderMap,
    Json(profile): Json<crate::directory::Profile>,
) -> Res<(StatusCode, Json<Value>)> {
    let session = require_session(&app, &headers)?;
    profile
        .validate_fields()
        .map_err(|e| Problem::bad_request("bad_profile", e))?;
    if session.address.to_lowercase() != profile.wallet {
        return Err(Problem::unauthorized(
            "the profile's wallet must be the signed-in address",
        ));
    }
    let id = parse_ns(&app, &profile.namespace)?;
    let ns = app
        .namespaces
        .get(&id)
        .ok_or_else(|| Problem::bad_request("unknown_namespace", "no such namespace"))?
        .clone();
    if profile.chain_id != ns.chain_id {
        return Err(Problem::bad_request(
            "wrong_chain",
            "the profile's chain must be the namespace's chain",
        ));
    }
    let now = product::now();
    if profile.issued_at > now + 600 || profile.issued_at + 3600 < now {
        return Err(Problem::bad_request(
            "bad_profile",
            "issued_at must be close to now",
        ));
    }
    if profile.expiry <= now {
        return Err(Problem::bad_request("bad_profile", "already expired"));
    }
    // The profile key must be the key the account derives from, and the
    // account must be registered, so a profile never points at an account
    // nobody can open.
    let account = fr_from_hex(&profile.account)?;
    let pk_bytes: [u8; 32] = hex::decode(&profile.profile_key)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| Problem::bad_request("bad_profile", "profile_key"))?;
    let pk = ed25519_dalek::VerifyingKey::from_bytes(&pk_bytes)
        .map_err(|_| Problem::bad_request("bad_profile", "profile_key is not a valid key"))?;
    if peal_bonsai::account::account_id(&id, &pk) != account {
        return Err(Problem::bad_request(
            "bad_profile",
            "profile_key does not derive the account on this namespace",
        ));
    }
    if ledger(&app, &id).account(account).await?.is_none() {
        return Err(Problem::bad_request(
            "unregistered_account",
            "the account is not registered on the ledger",
        ));
    }
    let rpc = if ns.rpc_url.is_empty() {
        None
    } else {
        Some(crate::evm::Rpc::new(&ns.rpc_url))
    };
    let verified = crate::directory::verify(&profile, rpc.as_ref())
        .await
        .map_err(Problem::unauthorized)?;
    let hash = hex::encode(profile.digest().map_err(Problem::internal)?);
    let conn = app.product.lock().expect("product lock");
    crate::directory::append(&conn, &hex::encode(id), &profile, &hash, &verified)
        .map_err(|e| Problem::conflict("profile_rejected", e))?;
    if profile.revoked {
        db(conn.execute(
            "UPDATE requests SET status = 'archived', updated_at = ?3 WHERE namespace = ?1 AND owner_address = ?2 AND status = 'active'",
            params![hex::encode(id), session.address, now as i64],
        ))?;
    }
    Ok((
        StatusCode::CREATED,
        Json(
            json!({ "hash": hash, "version": profile.version, "verified": verified.method, "block": verified.block }),
        ),
    ))
}

/// Resolve a wallet address to its receiving profile. Session-bound and
/// rate-limited; the client verifies the signature itself.
async fn get_profile(
    State(app): State<App>,
    headers: HeaderMap,
    Path((ns, address)): Path<(String, String)>,
) -> Res<Json<Value>> {
    require_session(&app, &headers)?;
    let token = bearer(&headers).unwrap_or_default();
    if !app
        .directory_limits
        .lock()
        .expect("limits lock")
        .allow(&token, DIRECTORY_LOOKUPS_PER_MINUTE)
    {
        return Err(Problem::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too many directory lookups; try again in a minute",
        ));
    }
    let id = parse_ns(&app, &ns)?;
    let address = address.to_lowercase();
    if !peal_bonsai::manifest::is_evm_address(&address) {
        return Err(Problem::bad_request(
            "malformed",
            "address must be a 0x address",
        ));
    }
    let conn = app.product.lock().expect("product lock");
    let stored =
        db(crate::directory::latest(&conn, &hex::encode(id), &address))?.ok_or_else(|| {
            Problem::not_found(
                "not_registered",
                "this address has not activated private receiving on Peal Links",
            )
        })?;
    Ok(Json(json!({
        "profile": stored.profile,
        "hash": stored.hash,
        "verified": stored.method,
        "block": stored.block,
        "log": stored.log,
    })))
}

async fn put_backup(
    State(app): State<App>,
    headers: HeaderMap,
    Path(ns): Path<String>,
    Json(b): Json<crate::directory::BackupUpload>,
) -> Res<Json<Value>> {
    let session = require_session(&app, &headers)?;
    let id = parse_ns(&app, &ns)?;
    let conn = app.product.lock().expect("product lock");
    crate::directory::store_backup(&conn, &hex::encode(id), &session.address.to_lowercase(), &b)
        .map_err(|e| Problem::conflict("backup_rejected", e))?;
    Ok(Json(json!({ "seq": b.seq })))
}

async fn get_backup(
    State(app): State<App>,
    headers: HeaderMap,
    Path(ns): Path<String>,
) -> Res<Json<Value>> {
    let session = require_session(&app, &headers)?;
    let id = parse_ns(&app, &ns)?;
    let conn = app.product.lock().expect("product lock");
    let (b, created_at) = db(crate::directory::latest_backup(
        &conn,
        &hex::encode(id),
        &session.address.to_lowercase(),
    ))?
    .ok_or_else(|| Problem::not_found("no_backup", "no backup is stored for this wallet"))?;
    Ok(Json(
        json!({ "seq": b.seq, "mechanism": b.mechanism, "blob": b.blob, "created_at": created_at }),
    ))
}

// ---- withdrawals -----------------------------------------------------------

async fn post_withdrawal(
    State(app): State<App>,
    Json(claim): Json<peal_bonsai::withdrawal::WithdrawalClaim>,
) -> Res<(StatusCode, Json<Value>)> {
    let cert = crate::settlement::settle(&app, claim).await?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::to_value(cert).expect("serializes")),
    ))
}

async fn get_withdrawal(
    State(app): State<App>,
    Path((ns, position)): Path<(String, u64)>,
) -> Res<Json<Value>> {
    let id = parse_ns(&app, &ns)?;
    let conn = app.product.lock().expect("product lock");
    let row: Option<(String, String, String, Option<String>, String, String)> = db(conn
        .query_row(
            "SELECT message, signatures, status, tx_hash, recipient, amount FROM withdrawals WHERE namespace = ?1 AND position = ?2",
            params![hex::encode(id), position as i64],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional())?;
    let (message, signatures, status, tx_hash, recipient, amount) = row.ok_or_else(|| {
        Problem::not_found(
            "unknown_withdrawal",
            "no settled withdrawal at that position",
        )
    })?;
    Ok(Json(json!({
        "position": position,
        "status": status,
        "tx_hash": tx_hash,
        "recipient": recipient,
        "amount": amount,
        "message": serde_json::from_str::<Value>(&message).unwrap_or(Value::Null),
        "signatures": serde_json::from_str::<Value>(&signatures).unwrap_or(Value::Null),
        "signers": app.committee.as_ref().map(|c| c.addresses()).unwrap_or_default(),
        "threshold": app.committee.as_ref().map(|c| c.threshold()).unwrap_or(0),
    })))
}

/// Per-namespace accounting: what the gateway holds versus what the ledger
/// owes. `minted - withdrawn` must equal balances plus unclaimed receipts;
/// user balances are proof-enforced, this is the aggregate for operators.
async fn ledger_accounting(State(app): State<App>, Path(ns): Path<String>) -> Res<Json<Value>> {
    let id = parse_ns(&app, &ns)?;
    let s = ledger(&app, &id).summary().await;
    let conn = app.product.lock().expect("product lock");
    let withdrawn = db(crate::settlement::withdrawn_total(&conn, &id))?;
    let minted: u128 = s.minted_total.parse().unwrap_or(0);
    Ok(Json(json!({
        "namespace": ns,
        "minted_total": minted.to_string(),
        "withdrawn_total": withdrawn.to_string(),
        "outstanding_liability": (minted - withdrawn).to_string(),
        "receipt_count": s.receipt_count,
    })))
}

#[derive(Deserialize)]
struct DevMintIn {
    namespace: String,
    receipt: String,
}

/// DEVELOPMENT FIXTURE. Credits a registered deposit intent without a chain
/// event. Only mounted when `dev_mint` is on (never with a mainnet
/// namespace); replaced by the watcher in Phase D. Recorded as a blocker.
async fn dev_mint(State(app): State<App>, Json(body): Json<DevMintIn>) -> Res<Json<Value>> {
    let ns = parse_ns(&app, &body.namespace)?;
    let receipt = parse_fr(&body.receipt)?;
    let deposit_id = format!("dev-mint:{}", product::random_token(8));
    Ok(Json(credit_intent(&app, ns, receipt, deposit_id).await?))
}

// ---- router ---------------------------------------------------------------

pub fn router(app: App) -> Router {
    let mut api = Router::new()
        .route("/status", get(status))
        .route("/consensus", get(consensus_view))
        .route("/params", get(params_index))
        .route("/params/{name}", get(params_file))
        .route("/ledger/{ns}", get(ledger_summary))
        .route("/ledger/{ns}/accounts/{acct}", get(ledger_account))
        .route("/ledger/{ns}/register", post(ledger_register))
        .route("/ledger/{ns}/ops", post(ledger_apply))
        .route("/ledger/{ns}/receipts/{pos}/path", get(ledger_path))
        .route("/ledger/{ns}/history", get(ledger_history))
        .route("/auth/nonce", get(auth_nonce))
        .route("/auth/session", post(auth_session))
        .route("/auth/me", get(auth_me))
        .route("/requests", post(create_request).get(list_requests))
        .route("/requests/{id}", get(get_request))
        .route("/requests/{id}/archive", post(archive_request))
        .route("/requests/{id}/reserve", post(reserve_request))
        .route("/requests/{id}/fulfill", post(fulfill_request))
        .route("/inbox/keys", post(bind_key))
        .route("/inbox/keys/{ns}/{acct}", get(get_key))
        .route("/inbox/{ns}/{acct}", post(post_inbox).get(get_inbox))
        .route("/deposits/intents", post(register_intent))
        .route("/deposits/intents/{ns}/{receipt}", get(get_intent))
        .route("/directory", put(put_profile))
        .route("/directory/{ns}/{address}", get(get_profile))
        .route("/backups/{ns}", put(put_backup).get(get_backup))
        .route("/withdrawals", post(post_withdrawal))
        .route("/withdrawals/{ns}/{position}", get(get_withdrawal))
        .route("/ledger/{ns}/accounting", get(ledger_accounting));
    if app.cfg.dev_mint {
        tracing::warn!("dev_mint is ON: /links/v1/dev/mint credits deposit intents without a chain event (development fixture)");
        api = api.route("/dev/mint", post(dev_mint));
    }
    let cors = tower_http::cors::CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        // PUT is how a profile is published and a backup uploaded. Same-origin
        // callers (the site behind Caddy) never preflight, so its absence went
        // unnoticed; a third-party page on its own origin preflights every PUT
        // and was refused before the request reached a handler.
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::ACCEPT,
            header::AUTHORIZATION,
            header::IF_NONE_MATCH,
            header::HeaderName::from_static("x-peal-inbox-auth"),
        ])
        .expose_headers([
            header::ETAG,
            header::HeaderName::from_static("x-peal-digest"),
        ]);
    Router::new()
        .nest("/links/v1", api)
        .route("/healthz", get(|| async { Json(json!({ "ok": true })) }))
        .layer(axum::extract::DefaultBodyLimit::max(256 * 1024))
        .layer(cors)
        .with_state(app)
}
