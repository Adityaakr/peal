//! The public API, designed around what callers do rather than how it works.
//!
//! WHY THIS EXISTS ALONGSIDE /v0. The v0 surface is the engine's own vocabulary:
//! conditions, ciphertexts, committees, work, shares. Those are the right names
//! inside the coordinator and the wrong ones in a public API, because they make
//! every caller learn the implementation before they can send a request. v1 has
//! two nouns:
//!
//!   ROUND  a moment, and everything sealed to it
//!   SEAL   one encrypted payload inside a round
//!
//! v0 is unchanged and still serves every existing client.
//!
//! THE DESIGN RULES, and what each one costs.
//!
//! 1. ONE RESOURCE, ONE LIFECYCLE. `GET /v1/rounds/{id}` answers 200 at every
//!    stage and carries a `status`. v0 split this across /conditions and
//!    /reveals, so "not open yet" arrived as a 404 and the documentation had to
//!    explain that a 404 was good news. A status code that needs a paragraph of
//!    apology is the wrong status code.
//!
//! 2. IDS ARE CONTENT ADDRESSED WHERE THEY CAN BE. A seal's id is the SHA-256 of
//!    its ciphertext, so a caller computes it locally and never has to trust our
//!    answer about which row is theirs. It costs an ugly 64 character id and it
//!    is worth it.
//!
//! 3. RETRIES ARE SAFE. `Idempotency-Key` on round creation returns the original
//!    round rather than making a second one. Agents retry on timeouts, and a
//!    duplicate round is a split auction. Seals are naturally idempotent: the
//!    same ciphertext has the same id.
//!
//! 4. ERRORS ARE MACHINE READABLE. RFC 9457 problem+json with a stable `code`,
//!    and `field` when one input is at fault. `{"error": "string"}` cannot be
//!    branched on, which pushes callers into matching English.
//!
//! 5. EVERY LIST IS PAGINATED THE SAME WAY, and can be filtered by tag. v0 could
//!    not answer "show me my rounds" at all, which made `tag` decorative.
//!
//! 6. TIME IS ISO 8601, always, with unix seconds beside it for arithmetic.
//!    Requests may say `opens_in` for convenience; responses never do, because a
//!    relative time in a stored object is ambiguous the moment it is stored.
//!
//! 7. POLLING IS CHEAP. `GET /v1/rounds/{id}` carries an ETag over the parts
//!    that change, so a caller waiting on a deadline can send
//!    `If-None-Match` and get 304s until something actually happens.

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::db::unix_now;
use crate::state::{new_id, App};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Page size when the caller does not say. Small enough to be a cheap default,
/// large enough that most callers never think about paging.
const DEFAULT_LIMIT: i64 = 25;
const MAX_LIMIT: i64 = 200;
/// How long a stored idempotency result stays valid. Long enough to cover any
/// realistic retry, short enough that keys do not accumulate for ever.
const IDEMPOTENCY_TTL_SECS: i64 = 24 * 60 * 60;

pub fn routes() -> Router<App> {
    Router::new()
        .route("/", get(service_root))
        .route("/parameters", get(parameters))
        .route("/rounds", post(create_round).get(list_rounds))
        .route("/rounds/{id}", get(get_round))
        .route("/rounds/{id}/seals", post(create_seal).get(list_seals))
        .route("/seals", post(create_lone_seal))
        .route("/seals/{id}", get(get_seal))
        .route("/seals/{id}/proof", get(get_seal_proof))
}

/// A JSON body extractor whose failures are problem+json like every other
/// error this API returns.
///
/// axum's own `Json` rejects with `text/plain`: a string body, no `code`, no
/// `field`. So a caller following the documentation, which says to branch on
/// `code`, hit `JSON.parse` on the words "Failed to deserialize the JSON body"
/// and got a parse error instead of the reason. Four of the most likely
/// mistakes anyone makes against this API were the four that came back in a
/// shape nothing could read.
pub struct ApiJson<T>(pub T);

impl<S, T> axum::extract::FromRequest<S> for ApiJson<T>
where
    T: serde::de::DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = Problem;

    async fn from_request(
        req: axum::extract::Request,
        state: &S,
    ) -> std::result::Result<Self, Self::Rejection> {
        use axum::extract::rejection::JsonRejection;
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(ApiJson(value)),
            Err(rejection) => Err(match rejection {
                // The body parsed as JSON but did not fit the type. The message
                // names the offending field, which is worth keeping: it is the
                // difference between "invalid body" and "opens_in must be a
                // number".
                JsonRejection::JsonDataError(e) => Problem::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "invalid_body",
                    tidy(&e.body_text()),
                ),
                JsonRejection::JsonSyntaxError(e) => Problem::new(
                    StatusCode::BAD_REQUEST,
                    "malformed_json",
                    tidy(&e.body_text()),
                ),
                JsonRejection::MissingJsonContentType(_) => Problem::new(
                    StatusCode::UNSUPPORTED_MEDIA_TYPE,
                    "unsupported_media_type",
                    "send this with `Content-Type: application/json`.",
                ),
                JsonRejection::BytesRejection(_) => Problem::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "payload_too_large",
                    "the request body is larger than this endpoint accepts.",
                ),
                other => Problem::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_body",
                    tidy(&other.body_text()),
                ),
            }),
        }
    }
}

/// axum's rejection text is a sentence with a stack of `serde` detail after it.
/// The first line is the useful part; the rest names internal types.
fn tidy(text: &str) -> String {
    let first = text.lines().next().unwrap_or(text).trim();
    let first = first
        .strip_prefix("Failed to deserialize the JSON body into the target type: ")
        .unwrap_or(first);
    let first = first
        .strip_prefix("Failed to parse the request body as JSON: ")
        .map(|rest| format!("the body is not valid JSON: {rest}"))
        .unwrap_or_else(|| first.to_string());
    let mut out = first.trim().to_string();
    if !out.ends_with('.') {
        out.push('.');
    }
    out
}

// ---------------------------------------------------------------- errors ----

/// RFC 9457 problem details.
///
/// `code` is the part callers should branch on: it is stable across wording
/// changes, which `detail` deliberately is not.
pub struct Problem {
    status: StatusCode,
    code: &'static str,
    detail: String,
    field: Option<&'static str>,
}

impl Problem {
    pub(crate) fn new(status: StatusCode, code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            status,
            code,
            detail: detail.into(),
            field: None,
        }
    }

    pub(crate) fn field(mut self, field: &'static str) -> Self {
        self.field = Some(field);
        self
    }

    pub(crate) fn invalid(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, detail)
    }

    pub(crate) fn missing(what: &str) -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("no such {what}"),
        )
    }

    pub(crate) fn internal(e: impl std::fmt::Display) -> Self {
        tracing::error!(error = %e, "v1 internal error");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "the coordinator could not complete this request",
        )
    }
}

impl IntoResponse for Problem {
    fn into_response(self) -> Response {
        let mut body = Map::new();
        // A resolvable type URI, so the code is documented rather than folklore.
        body.insert(
            "type".into(),
            json!(format!("https://peal.network/#/developers#{}", self.code)),
        );
        body.insert("title".into(), json!(title_for(self.status)));
        body.insert("status".into(), json!(self.status.as_u16()));
        body.insert("code".into(), json!(self.code));
        body.insert("detail".into(), json!(self.detail));
        if let Some(f) = self.field {
            body.insert("field".into(), json!(f));
        }
        let mut res = (self.status, Json(Value::Object(body))).into_response();
        res.headers_mut().insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/problem+json"),
        );
        res
    }
}

fn title_for(status: StatusCode) -> &'static str {
    match status {
        StatusCode::BAD_REQUEST => "invalid request",
        StatusCode::NOT_FOUND => "not found",
        StatusCode::CONFLICT => "conflict",
        StatusCode::UNPROCESSABLE_ENTITY => "unprocessable",
        _ => "error",
    }
}

pub(crate) type Result<T> = std::result::Result<T, Problem>;

// ------------------------------------------------------------ service root --

/// GET /v1
///
/// What this deployment is and what it will accept. Everything a client needs
/// to configure itself is here, so limits live in one place rather than in
/// prose that drifts from the code enforcing them.
async fn service_root(State(app): State<App>) -> Json<Value> {
    Json(json!({
        "service": "peal",
        "version": "v1",
        "documentation": "https://peal.network/#/developers",
        "resources": {
            "rounds": "/v1/rounds",
            "seals": "/v1/seals/{id}",
            "parameters": "/v1/parameters",
        },
        "limits": {
            "max_payload_bytes": bte_crypto::MAX_PAYLOAD_BYTES,
            "max_page_size": MAX_LIMIT,
            "default_page_size": DEFAULT_LIMIT,
            "requests_per_second": app.0.cfg.rate_rps,
            "burst": app.0.cfg.rate_burst,
            "idempotency_ttl_seconds": IDEMPOTENCY_TTL_SECS,
        },
        "time": iso(unix_now()),
    }))
}

/// GET /v1/parameters
///
/// The public key material to encrypt against, with the digest a client checks
/// before using it. Named for what it is for rather than after the committee
/// table it comes from.
async fn parameters(State(app): State<App>) -> Result<Json<Value>> {
    let id = default_committee(&app).ok_or_else(|| {
        Problem::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "no_committee",
            "this coordinator has no committee registered yet",
        )
    })?;
    let conn = app.0.db.lock().unwrap();
    let (blob, digest, n, t, b, scheme): (Vec<u8>, String, i64, i64, i64, String) = conn
        .query_row(
            "SELECT params_blob, params_digest, n, t, b, scheme FROM committees WHERE id = ?1",
            [&id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .map_err(|_| Problem::missing("committee"))?;
    Ok(Json(json!({
        "id": id,
        "digest": digest,
        "scheme": scheme,
        "parameters_b64": B64.encode(&blob),
        "operators": n,
        "threshold": t,
        "batch_size": b,
    })))
}

// ----------------------------------------------------------------- rounds ---

// Serialize as well as Deserialize: the idempotency fingerprint is taken over
// the parsed request, so a retry that differs only in whitespace or key order
// is still recognised as the same request.
#[derive(Deserialize, Serialize)]
struct CreateRound {
    /// Absolute, and preferred: RFC 3339, or unix seconds as a number.
    opens_at: Option<Value>,
    /// Relative sugar. Accepted on the way in, never returned.
    opens_in: Option<i64>,
    /// Open on a chain height instead of a clock.
    opens_at_block: Option<OpensAtBlock>,
    tag: Option<String>,
    /// What this round is, for anyone who sees it before it opens.
    title: Option<String>,
    description: Option<String>,
    /// An https picture. Public from the moment the round is created.
    image_url: Option<String>,
}

/// Public presentation. Separated from the request struct because it is
/// validated as a unit and travels as a unit.
#[derive(Clone, Default)]
struct Presentation {
    title: Option<String>,
    description: Option<String>,
    image_url: Option<String>,
}

/// What a round may say about itself.
///
/// PUBLIC, AND THE NAMES SAY SO. A payload is sealed; this is not. It is
/// readable by anyone who has the round id from the moment the round is
/// created, which is the point: it is what a bidder reads to decide what they
/// are bidding on. Putting anything sensitive here would be putting it in the
/// clear, so the field names avoid any word that might suggest otherwise.
const MAX_TITLE_CHARS: usize = 120;
const MAX_DESCRIPTION_CHARS: usize = 2000;
const MAX_IMAGE_URL_CHARS: usize = 500;

fn validate_presentation(req: &CreateRound) -> Result<Presentation> {
    let text = |v: &Option<String>,
                cap: usize,
                field: &'static str,
                code: &'static str|
     -> Result<Option<String>> {
        let Some(raw) = v else { return Ok(None) };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        if trimmed.chars().count() > cap {
            return Err(
                Problem::invalid(code, format!("{field} exceeds {cap} characters")).field(field),
            );
        }
        Ok(Some(trimmed.to_string()))
    };

    let image_url = match req
        .image_url
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        None => None,
        Some(url) => {
            // https only. An http picture makes the whole page insecure for
            // whoever renders it, and a javascript: or data: URL is not a
            // picture at all: it is markup pointed at whoever displays the
            // round. Refused rather than sanitised, because the caller can fix
            // it and we cannot guess what they meant.
            if !url.starts_with("https://") {
                return Err(Problem::invalid(
                    "invalid_image_url",
                    "image_url must be an https address",
                )
                .field("image_url"));
            }
            if url.chars().count() > MAX_IMAGE_URL_CHARS {
                return Err(Problem::invalid(
                    "invalid_image_url",
                    format!("image_url exceeds {MAX_IMAGE_URL_CHARS} characters"),
                )
                .field("image_url"));
            }
            if url.contains(char::is_whitespace) {
                return Err(
                    Problem::invalid("invalid_image_url", "image_url contains whitespace")
                        .field("image_url"),
                );
            }
            Some(url.to_string())
        }
    };

    Ok(Presentation {
        title: text(&req.title, MAX_TITLE_CHARS, "title", "invalid_title")?,
        description: text(
            &req.description,
            MAX_DESCRIPTION_CHARS,
            "description",
            "invalid_description",
        )?,
        image_url,
    })
}

#[derive(Deserialize, Serialize)]
struct OpensAtBlock {
    chain_id: i64,
    height: i64,
}

/// What another module needs to open a round. The auction layer builds one of
/// these rather than a second copy of the validation.
pub(crate) struct RoundSpec {
    pub opens_at: Option<Value>,
    pub opens_in: Option<i64>,
    pub tag: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image_url: Option<String>,
}

pub(crate) async fn create_round_inner(
    app: &App,
    headers: HeaderMap,
    spec: RoundSpec,
) -> Result<Value> {
    let res = create_round(
        State(app.clone()),
        headers,
        ApiJson(CreateRound {
            opens_at: spec.opens_at,
            opens_in: spec.opens_in,
            opens_at_block: None,
            tag: spec.tag,
            title: spec.title,
            description: spec.description,
            image_url: spec.image_url,
        }),
    )
    .await?;
    body_json(res).await
}

/// Submitting a bid is submitting a seal. Shared so an auction cannot drift
/// from a round on validation, the closed check, or idempotency.
pub(crate) async fn create_seal_inner(app: &App, round_id: &str, body: Value) -> Result<Response> {
    let req: CreateSeal = serde_json::from_value(body).map_err(|_| {
        Problem::invalid("invalid_body", "expected { ciphertext_b64 }").field("ciphertext_b64")
    })?;
    create_seal(State(app.clone()), Path(round_id.to_string()), ApiJson(req)).await
}

/// One round as JSON, for a module that presents it differently.
pub(crate) fn round_value(app: &App, id: &str) -> Result<Value> {
    load_round(app, id)
}

/// The revealed slots of a round, or None while it is closed.
pub(crate) fn reveal_slots(app: &App, round_id: &str) -> Option<Vec<Value>> {
    let conn = app.0.db.lock().unwrap();
    let blob: String = conn
        .query_row(
            "SELECT payloads_blob FROM reveals WHERE condition_id = ?1",
            [round_id],
            |r| r.get(0),
        )
        .ok()?;
    serde_json::from_str(&blob).ok()
}

/// POST /v1/rounds
async fn create_round(
    State(app): State<App>,
    headers: HeaderMap,
    ApiJson(req): ApiJson<CreateRound>,
) -> Result<Response> {
    let fingerprint = request_fingerprint(&req);
    let idempotency_key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    if let Some(key) = &idempotency_key {
        if key.len() > 200 {
            return Err(
                Problem::invalid("invalid_idempotency_key", "key is too long")
                    .field("Idempotency-Key"),
            );
        }
        match replay(&app, key, &fingerprint)? {
            // 200 rather than 201: this call created nothing.
            Replay::Same(existing) => return Ok((StatusCode::OK, Json(*existing)).into_response()),
            // Silently handing back the first round was the dangerous answer:
            // an agent retrying with a new deadline got the old one, with a
            // 200 and nothing to branch on.
            Replay::Different => {
                return Err(Problem::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "idempotency_key_reused",
                    "this Idempotency-Key was already used with a different request. \
                     Use a new key, or send the original request again.",
                )
                .field("Idempotency-Key"))
            }
            Replay::Fresh => {}
        }
    }

    let tag = validate_tag(req.tag.as_deref())?;
    let show = validate_presentation(&req)?;
    let committee_id = default_committee(&app).ok_or_else(|| {
        Problem::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "no_committee",
            "this coordinator has no committee registered yet",
        )
    })?;

    let now = unix_now();
    let id = new_id("cond");

    let body = match (&req.opens_at_block, req.opens_at.as_ref(), req.opens_in) {
        (Some(block), _, _) => {
            if !app.0.cfg.rpc_urls.contains_key(&block.chain_id) {
                return Err(Problem::invalid(
                    "unsupported_chain",
                    format!("this coordinator does not watch chain {}", block.chain_id),
                )
                .field("opens_at_block.chain_id"));
            }
            if block.height <= 0 {
                return Err(
                    Problem::invalid("invalid_height", "height must be positive")
                        .field("opens_at_block.height"),
                );
            }
            let conn = app.0.db.lock().unwrap();
            conn.execute(
                "INSERT INTO conditions
                   (id, committee_id, kind, chain_id, height, status, tag, title, description, image_url, created_at)
                 VALUES (?1, ?2, 'at_block', ?3, ?4, 'pending', ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    id,
                    committee_id,
                    block.chain_id,
                    block.height,
                    tag,
                    show.title,
                    show.description,
                    show.image_url,
                    now
                ],
            )
            .map_err(Problem::internal)?;
            round_json(
                &id,
                "open",
                None,
                Some((block.chain_id, block.height)),
                &tag,
                &show,
                now,
                0,
                0,
                None,
            )
        }
        (None, opens_at, opens_in) => {
            let at = match (opens_at, opens_in) {
                (Some(v), _) => parse_time(v)?,
                (None, Some(secs)) => {
                    if secs <= 0 {
                        return Err(
                            Problem::invalid("opens_in_past", "opens_in must be positive")
                                .field("opens_in"),
                        );
                    }
                    now + secs
                }
                (None, None) => {
                    return Err(Problem::invalid(
                        "missing_deadline",
                        "give opens_at, opens_in or opens_at_block",
                    )
                    .field("opens_at"))
                }
            };
            if at <= now {
                return Err(Problem::invalid(
                    "opens_in_past",
                    "a round cannot open in the past; nothing could be sealed to it",
                )
                .field("opens_at"));
            }
            let conn = app.0.db.lock().unwrap();
            conn.execute(
                "INSERT INTO conditions
                   (id, committee_id, kind, fires_at, status, tag, title, description, image_url, created_at)
                 VALUES (?1, ?2, 'at_time', ?3, 'pending', ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    id, committee_id, at, tag, show.title, show.description, show.image_url, now
                ],
            )
            .map_err(Problem::internal)?;
            round_json(&id, "open", Some(at), None, &tag, &show, now, 0, 0, None)
        }
    };

    if let Some(key) = &idempotency_key {
        remember(&app, key, &id, &body, &fingerprint, now)?;
    }

    // 201 with a Location, so a caller can follow the resource it just made.
    let mut res = (StatusCode::CREATED, Json(body)).into_response();
    if let Ok(v) = header::HeaderValue::from_str(&format!("/v1/rounds/{id}")) {
        res.headers_mut().insert(header::LOCATION, v);
    }
    Ok(res)
}

#[derive(Deserialize)]
struct ListRounds {
    tag: Option<String>,
    status: Option<String>,
    limit: Option<i64>,
    cursor: Option<String>,
}

/// GET /v1/rounds
///
/// Filtered by tag, which is the query v0 could not answer and the reason tags
/// existed in the first place.
async fn list_rounds(State(app): State<App>, Query(q): Query<ListRounds>) -> Result<Json<Value>> {
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let status = match q.status.as_deref() {
        None => None,
        Some(s) => Some(internal_status(s)?),
    };
    let after = q.cursor.as_deref().map(decode_cursor).transpose()?;

    let conn = app.0.db.lock().unwrap();
    // Ordered newest first, tie-broken on id so the cursor is total: without the
    // tie-break, rows created in the same second can be skipped or repeated
    // across pages.
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.status, c.fires_at, c.chain_id, c.height, c.tag, c.created_at,
                    (SELECT COUNT(*) FROM ciphertexts x WHERE x.condition_id = c.id AND x.is_dummy = 0),
                    (SELECT COUNT(*) FROM ciphertexts x WHERE x.condition_id = c.id),
                    (SELECT r.revealed_at FROM reveals r WHERE r.condition_id = c.id),
                    c.title, c.description, c.image_url
               FROM conditions c
              WHERE (?1 IS NULL OR c.tag = ?1)
                AND (?2 IS NULL OR c.status = ?2)
                AND (?3 IS NULL OR (c.created_at, c.id) < (?3, ?4))
              ORDER BY c.created_at DESC, c.id DESC
              LIMIT ?5",
        )
        .map_err(Problem::internal)?;

    let (cur_at, cur_id) = match &after {
        Some((at, id)) => (Some(*at), Some(id.as_str())),
        None => (None, None),
    };
    let rows = stmt
        .query_map(
            rusqlite::params![q.tag, status, cur_at, cur_id, limit + 1],
            |r| {
                Ok(round_json(
                    &r.get::<_, String>(0)?,
                    public_status(&r.get::<_, String>(1)?),
                    r.get::<_, Option<i64>>(2)?,
                    match (r.get::<_, Option<i64>>(3)?, r.get::<_, Option<i64>>(4)?) {
                        (Some(c), Some(h)) => Some((c, h)),
                        _ => None,
                    },
                    &r.get::<_, Option<String>>(5)?,
                    &Presentation {
                        title: r.get::<_, Option<String>>(10)?,
                        description: r.get::<_, Option<String>>(11)?,
                        image_url: r.get::<_, Option<String>>(12)?,
                    },
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, i64>(8)?,
                    r.get::<_, Option<i64>>(9)?,
                ))
            },
        )
        .map_err(Problem::internal)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Problem::internal)?;

    // One extra row was asked for: its existence is the only reliable way to
    // know there is a next page without a second count query.
    let has_more = rows.len() as i64 > limit;
    let page: Vec<Value> = rows.into_iter().take(limit as usize).collect();
    let next = if has_more {
        page.last().map(|r| {
            encode_cursor(
                r["created_at_unix"].as_i64().unwrap_or(0),
                r["id"].as_str().unwrap_or(""),
            )
        })
    } else {
        None
    };

    Ok(Json(
        json!({ "data": page, "next_cursor": next, "has_more": has_more }),
    ))
}

/// GET /v1/rounds/{id}
///
/// 200 at every stage. The result is embedded once the round has opened, so a
/// caller polls one URL from creation to payload and never has to treat a 404
/// as good news.
async fn get_round(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let round = load_round(&app, &id)?;

    // An ETag over the parts that move. A poller waiting out a deadline sends
    // If-None-Match and gets 304 until something has actually happened.
    let tag = etag(&round);
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|c| c.trim() == tag))
    {
        return Ok(StatusCode::NOT_MODIFIED.into_response());
    }

    let mut res = Json(round).into_response();
    if let Ok(v) = header::HeaderValue::from_str(&tag) {
        res.headers_mut().insert(header::ETAG, v);
    }
    Ok(res)
}

// ------------------------------------------------------------------ seals ---

#[derive(Deserialize)]
struct CreateSeal {
    /// The ciphertext, base64. Named for what it is: this endpoint has never
    /// accepted a plaintext and never will, because accepting one would move
    /// the encryption to the wrong side of the network.
    ciphertext_b64: String,
}

/// POST /v1/rounds/{id}/seals
async fn create_seal(
    State(app): State<App>,
    Path(round_id): Path<String>,
    ApiJson(req): ApiJson<CreateSeal>,
) -> Result<Response> {
    let max_b64 = (bte_crypto::MAX_PAYLOAD_BYTES + 4096) * 4 / 3 + 8;
    if req.ciphertext_b64.len() > max_b64 {
        return Err(
            Problem::invalid("payload_too_large", "the ciphertext exceeds the limit")
                .field("ciphertext_b64"),
        );
    }
    let blob = B64.decode(req.ciphertext_b64.as_bytes()).map_err(|_| {
        Problem::invalid("invalid_base64", "ciphertext_b64 is not valid base64")
            .field("ciphertext_b64")
    })?;

    // Parsed, on curve and subgroup checked before it is stored. A round is a
    // public batch: one unopenable member would spoil the reveal for everyone
    // in it, so garbage is refused at the door rather than at decryption.
    let ct = crate::scheme::Sealed::parse(&blob).map_err(|e| {
        Problem::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_ciphertext",
            format!("this is not a well formed ciphertext: {e}"),
        )
        .field("ciphertext_b64")
    })?;
    let id = hex::encode(ct.hash());

    let round_closed = || {
        Problem::new(
            StatusCode::CONFLICT,
            "round_closed",
            "this round has already closed; nothing further can be sealed to it",
        )
    };
    let committee = {
        let conn = app.0.db.lock().unwrap();
        let (status, committee_id) = crate::api::condition_intake_state(&conn, &round_id)
            .map_err(|_| Problem::missing("round"))?;
        if status != "pending" {
            return Err(round_closed());
        }
        app.committee(&committee_id)
            .ok_or_else(|| Problem::internal("committee not cached"))?
    };
    // The proof check runs outside the lock.
    let ct = tokio::task::spawn_blocking({
        let committee = committee.clone();
        let round_id = round_id.clone();
        move || ct.admit(&committee, &round_id).map(|()| ct)
    })
    .await
    .map_err(Problem::internal)?
    .map_err(|e| {
        Problem::new(StatusCode::UNPROCESSABLE_ENTITY, "invalid_ciphertext", e)
            .field("ciphertext_b64")
    })?;

    let conn = app.0.db.lock().unwrap();
    let (status, _) = crate::api::condition_intake_state(&conn, &round_id)
        .map_err(|_| Problem::missing("round"))?;
    if status != "pending" {
        return Err(round_closed());
    }
    crate::api::check_capacity(&conn, &committee, &round_id).map_err(|e| {
        Problem::new(StatusCode::UNPROCESSABLE_ENTITY, "invalid_ciphertext", e)
            .field("ciphertext_b64")
    })?;

    // The same ciphertext is the same seal: its id is its hash, so a retry
    // cannot create a second row and does not need an idempotency key. A
    // different ciphertext with the same KEM point is a conflict.
    let inserted = conn
        .execute(
            "INSERT INTO ciphertexts (ct_hash, condition_id, sealed_blob, is_dummy, created_at, code, kem_point)
             VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6) ON CONFLICT(ct_hash) DO NOTHING",
            rusqlite::params![
                id,
                round_id,
                blob,
                unix_now(),
                crate::state::new_share_code(),
                ct.kem_point_hex()
            ],
        )
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(f, _)
                if f.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                Problem::new(
                    StatusCode::CONFLICT,
                    "duplicate_randomness",
                    "a ciphertext with this randomness is already sealed to this round",
                )
            }
            other => Problem::internal(other),
        })?;

    let body = json!({
        "id": id,
        "round_id": round_id,
        "status": "sealed",
        "id_is": "sha256 of the ciphertext, so you can compute it yourself",
    });
    let code = if inserted == 1 {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    let mut res = (code, Json(body)).into_response();
    if let Ok(v) = header::HeaderValue::from_str(&format!("/v1/seals/{id}")) {
        res.headers_mut().insert(header::LOCATION, v);
    }
    Ok(res)
}

/// GET /v1/rounds/{id}/seals
///
/// Ids while the round is open, payloads once it has opened. Same URL, same
/// shape, one field appears. Nothing here can leak early: before the reveal the
/// coordinator does not hold a payload to leak.
async fn list_seals(State(app): State<App>, Path(round_id): Path<String>) -> Result<Json<Value>> {
    let round = load_round(&app, &round_id)?;
    let opened = round["status"] == "opened";

    // Read the payloads BEFORE taking the connection. The db handle is behind a
    // plain Mutex, which is not reentrant, so doing this while holding `conn`
    // deadlocks the whole coordinator on the first request for an opened
    // round's seals.
    let payloads = if opened {
        reveal_payloads(&app, &round_id)
    } else {
        None
    };

    let conn = app.0.db.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT ct_hash, position, is_dummy FROM ciphertexts
              WHERE condition_id = ?1 AND is_dummy = 0
              ORDER BY position IS NULL, position ASC, ct_hash ASC",
        )
        .map_err(Problem::internal)?;
    let rows = stmt
        .query_map([&round_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, i64>(2)? != 0,
            ))
        })
        .map_err(Problem::internal)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Problem::internal)?;

    // The list is the same disclosure as the count, one level down: eight ids
    // on an open round is eight submissions. A caller who sealed something has
    // its id from the response to their own POST and can read it back at
    // /v1/seals/{id}; nobody needs the whole list before the round opens.
    if !opened {
        return Ok(Json(json!({
            "data": Value::Null,
            "available_at": round.get("opens_at").cloned().unwrap_or(Value::Null),
            "note": "sealed submissions are listed once the round opens. \
                     Read your own with GET /v1/seals/{id}.",
        })));
    }

    let data: Vec<Value> = rows
        .into_iter()
        .map(|(hash, position, _)| {
            let mut o = Map::new();
            o.insert("id".into(), json!(hash));
            o.insert("position".into(), json!(position));
            o.insert(
                "status".into(),
                json!(if opened { "opened" } else { "sealed" }),
            );
            if let Some(map) = payloads.as_ref() {
                if let Some(p) = map.get(&hash) {
                    o.insert("payload_b64".into(), json!(p));
                }
            }
            Value::Object(o)
        })
        .collect();

    Ok(Json(json!({
        "data": data,
        "round": { "id": round_id, "status": round["status"] },
    })))
}

/// GET /v1/seals/{id}
async fn get_seal(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Value>> {
    let conn = app.0.db.lock().unwrap();
    let (round_id, position): (String, Option<i64>) = conn
        .query_row(
            "SELECT condition_id, position FROM ciphertexts WHERE ct_hash = ?1 AND is_dummy = 0",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| Problem::missing("seal"))?;
    drop(conn);

    let round = load_round(&app, &round_id)?;
    let opened = round["status"] == "opened";
    let mut o = Map::new();
    o.insert("id".into(), json!(id));
    o.insert("round_id".into(), json!(round_id));
    o.insert("position".into(), json!(position));
    o.insert(
        "status".into(),
        json!(if opened { "opened" } else { "sealed" }),
    );
    if opened {
        if let Some(p) = reveal_payloads(&app, &round_id).and_then(|m| m.get(&id).cloned()) {
            o.insert("payload_b64".into(), json!(p));
        }
    }
    o.insert(
        "round".into(),
        json!({ "id": round_id, "status": round["status"] }),
    );
    Ok(Json(Value::Object(o)))
}

/// One sealed payload with its own deadline, in one call.
///
/// A round holding a single seal. Most callers, and nearly every agent, want
/// exactly this: seal a thing until a time, get something back that proves it
/// was sealed before it was opened. Doing it with the two-step API means
/// creating a round and then posting to it, which is two round trips and two
/// ids to keep.
///
/// THE PAYLOAD IS A CIPHERTEXT AND ONLY EVER A CIPHERTEXT. There is no
/// convenience field that takes a plaintext and encrypts it here. That would
/// move the encryption to the wrong side of the network and quietly delete the
/// only property this product has: use peal.js, or any client that speaks the
/// wire format, and encrypt where your data already is.
#[derive(Deserialize)]
struct CreateLoneSeal {
    ciphertext_b64: String,
    /// When it opens: RFC 3339, or unix seconds.
    unlock_at: Option<Value>,
    /// Or relative seconds.
    unlock_in: Option<i64>,
    tag: Option<String>,
    title: Option<String>,
}

async fn create_lone_seal(
    State(app): State<App>,
    headers: HeaderMap,
    ApiJson(req): ApiJson<CreateLoneSeal>,
) -> Result<Response> {
    let round_req = CreateRound {
        opens_at: req.unlock_at.clone(),
        opens_in: req.unlock_in,
        opens_at_block: None,
        tag: req.tag.clone(),
        title: req.title.clone(),
        description: None,
        image_url: None,
    };
    // Reuse the round path wholesale rather than reimplementing validation, so
    // a rule can never hold on one endpoint and not the other.
    let created = create_round(State(app.clone()), headers, ApiJson(round_req)).await?;
    let round: Value = body_json(created).await?;
    let round_id = round["id"].as_str().unwrap_or_default().to_string();

    let sealed = create_seal(
        State(app.clone()),
        Path(round_id.clone()),
        ApiJson(CreateSeal {
            ciphertext_b64: req.ciphertext_b64,
        }),
    )
    .await?;
    let seal: Value = body_json(sealed).await?;
    let id = seal["id"].as_str().unwrap_or_default().to_string();

    let body = json!({
        "id": id,
        "round_id": round_id,
        "status": "sealed",
        "unlock_at": round["opens_at"],
        "unlock_at_unix": round["opens_at_unix"],
        "proof_url": format!("/v1/seals/{id}/proof"),
    });
    let mut res = (StatusCode::CREATED, Json(body)).into_response();
    if let Ok(v) = header::HeaderValue::from_str(&format!("/v1/seals/{id}")) {
        res.headers_mut().insert(header::LOCATION, v);
    }
    Ok(res)
}

/// Read a JSON body back out of a response we just built.
async fn body_json(res: Response) -> Result<Value> {
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .map_err(Problem::internal)?;
    serde_json::from_slice(&bytes).map_err(Problem::internal)
}

/// GET /v1/seals/{id}/proof
///
/// What can actually be checked about one seal, and nothing that cannot.
///
/// The load-bearing claim is `ordering_committed_at`: the coordinator writes
/// the batch's ordering root at freeze, BEFORE any operator is handed work, so
/// a commitment timestamp earlier than the reveal is evidence the set and its
/// order were fixed before anybody could open it. `id` is the SHA-256 of the
/// ciphertext, so the caller checks that themselves rather than believing us.
async fn get_seal_proof(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Value>> {
    let conn = app.0.db.lock().unwrap();
    let (round_id, position): (String, Option<i64>) = conn
        .query_row(
            "SELECT condition_id, position FROM ciphertexts WHERE ct_hash = ?1 AND is_dummy = 0",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| Problem::missing("seal"))?;

    let commitment: Option<(String, i64, i64)> = conn
        .query_row(
            "SELECT ordering_root, committed_at, batch_size FROM batch_commitments
              WHERE condition_id = ?1 ORDER BY committed_at ASC LIMIT 1",
            [&round_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();

    let reveal: Option<(String, i64)> = conn
        .query_row(
            "SELECT merkle_root, revealed_at FROM reveals WHERE condition_id = ?1",
            [&round_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    drop(conn);

    let round = load_round(&app, &round_id)?;
    let (ordering_root, committed_at, batch_size) = match &commitment {
        Some((root, at, size)) => (json!(root), json!(at), json!(size)),
        None => (Value::Null, Value::Null, Value::Null),
    };
    let (merkle_root, revealed_at) = match &reveal {
        Some((root, at)) => (json!(root), json!(at)),
        None => (Value::Null, Value::Null),
    };

    // Only true when both timestamps exist and fall the right way round. Absent
    // is null, not false: "not yet" and "no" are different answers.
    let precedes = match (&commitment, &reveal) {
        (Some((_, c, _)), Some((_, r))) => json!(c <= r),
        _ => Value::Null,
    };

    Ok(Json(json!({
        "seal_id": id,
        "seal_id_is": "sha256 of the ciphertext; recompute it from your own copy",
        "round_id": round_id,
        "round_status": round["status"],
        "position": position,
        "position_is": "derived from the ciphertext hashes, not from arrival order",
        "ordering_root": ordering_root,
        "ordering_committed_at": committed_at,
        "batch_size": batch_size,
        "merkle_root": merkle_root,
        "revealed_at": revealed_at,
        "commitment_precedes_reveal": precedes,
        "threshold": "3 of 5 operators are required to open a batch",
    })))
}

// ----------------------------------------------------------------- shared ---

fn default_committee(app: &App) -> Option<String> {
    let conn = app.0.db.lock().unwrap();
    conn.query_row(
        "SELECT id FROM committees ORDER BY created_at DESC, id LIMIT 1",
        [],
        |r| r.get(0),
    )
    .ok()
}

fn validate_tag(tag: Option<&str>) -> Result<Option<String>> {
    let Some(t) = tag else { return Ok(None) };
    let t = t.trim();
    if t.is_empty() {
        return Ok(None);
    }
    if t.len() > 32
        || !t.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || b == b':' || b == b'-' || b == b'_'
        })
    {
        return Err(Problem::invalid(
            "invalid_tag",
            "a tag is up to 32 characters of a-z, 0-9, colon, hyphen or underscore",
        )
        .field("tag"));
    }
    Ok(Some(t.to_string()))
}

/// Accepts RFC 3339 or unix seconds, because an API that takes only one of them
/// makes half its callers write a conversion.
fn parse_time(v: &Value) -> Result<i64> {
    if let Some(n) = v.as_i64() {
        return Ok(n);
    }
    if let Some(s) = v.as_str() {
        if let Ok(n) = s.parse::<i64>() {
            return Ok(n);
        }
        if let Some(secs) = parse_rfc3339(s) {
            return Ok(secs);
        }
    }
    Err(Problem::invalid(
        "invalid_time",
        "opens_at must be RFC 3339 (2026-09-12T18:00:00Z) or unix seconds",
    )
    .field("opens_at"))
}

/// A deliberately small RFC 3339 reader: the subset this API documents, in UTC.
/// Pulling in a date library to parse one shape we control is not a trade worth
/// making, and anything outside the subset is rejected rather than guessed at.
fn parse_rfc3339(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') {
        return None;
    }
    if !s.ends_with('Z') && !s.ends_with("+00:00") {
        return None;
    }
    let num = |from: usize, to: usize| s.get(from..to)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    // Days from the civil epoch (Howard Hinnant's algorithm).
    let ya = if mo <= 2 { y - 1 } else { y };
    let era = if ya >= 0 { ya } else { ya - 399 } / 400;
    let yoe = ya - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + sec)
}

fn iso(unix: i64) -> String {
    // Civil date from days, the inverse of the above.
    let days = unix.div_euclid(86_400);
    let secs = unix.rem_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

/// The engine's status words are internal. These are the four a caller cares
/// about, and they are a promise: `opened` always means the payloads are there.
fn public_status(internal: &str) -> &'static str {
    match internal {
        "pending" => "open",
        "frozen" => "closing",
        "revealed" => "opened",
        _ => "stalled",
    }
}

fn internal_status(public: &str) -> Result<&'static str> {
    Ok(match public {
        "open" => "pending",
        "closing" => "frozen",
        "opened" => "revealed",
        "stalled" => "stalled",
        _ => {
            return Err(Problem::invalid(
                "invalid_status",
                "status must be one of open, closing, opened, stalled",
            )
            .field("status"))
        }
    })
}

#[allow(clippy::too_many_arguments)]
fn round_json(
    id: &str,
    status: &str,
    opens_at: Option<i64>,
    block: Option<(i64, i64)>,
    tag: &Option<String>,
    show: &Presentation,
    created_at: i64,
    seals: i64,
    slots: i64,
    opened_at: Option<i64>,
) -> Value {
    let mut o = Map::new();
    o.insert("id".into(), json!(id));
    o.insert("status".into(), json!(status));
    o.insert("tag".into(), json!(tag));
    // Public from creation, unlike everything sealed to the round.
    o.insert("title".into(), json!(show.title));
    o.insert("description".into(), json!(show.description));
    o.insert("image_url".into(), json!(show.image_url));
    match (opens_at, block) {
        (Some(at), _) => {
            o.insert("opens_at".into(), json!(iso(at)));
            o.insert("opens_at_unix".into(), json!(at));
        }
        (None, Some((chain_id, height))) => {
            o.insert("opens_at".into(), Value::Null);
            o.insert(
                "opens_at_block".into(),
                json!({ "chain_id": chain_id, "height": height }),
            );
        }
        _ => {
            o.insert("opens_at".into(), Value::Null);
        }
    }
    // Not published until the round opens.
    //
    // The documentation says in four places that a quiet round does not
    // announce how few sealed to it, and this field announced it exactly:
    // `seals: 2` on an open round is the number a competitor in a sealed
    // auction most wants, at the only time it is worth anything. The decoy
    // padding hides which slots were real once a batch is revealed; it does
    // nothing about a live count served straight from the table.
    //
    // Null rather than absent, and null rather than zero, following what
    // auction results already do with `bids` before the close: a caller can
    // tell "not yet" from "none", which is the distinction that matters.
    let public = status == "opened" || status == "stalled";
    o.insert(
        "seals".into(),
        if public { json!(seals) } else { Value::Null },
    );
    // Named for what it is. Callers kept reading a slot count as a participant
    // count, and it is not: the batch is padded so it cannot be one.
    o.insert(
        "slots_including_decoys".into(),
        if public { json!(slots) } else { Value::Null },
    );
    o.insert("created_at".into(), json!(iso(created_at)));
    o.insert("created_at_unix".into(), json!(created_at));
    match opened_at {
        Some(at) => {
            o.insert("opened_at".into(), json!(iso(at)));
            o.insert("seals_url".into(), json!(format!("/v1/rounds/{id}/seals")));
        }
        None => {
            o.insert("opened_at".into(), Value::Null);
        }
    }
    Value::Object(o)
}

fn load_round(app: &App, id: &str) -> Result<Value> {
    let conn = app.0.db.lock().unwrap();
    conn.query_row(
        "SELECT c.id, c.status, c.fires_at, c.chain_id, c.height, c.tag, c.created_at,
                (SELECT COUNT(*) FROM ciphertexts x WHERE x.condition_id = c.id AND x.is_dummy = 0),
                (SELECT COUNT(*) FROM ciphertexts x WHERE x.condition_id = c.id),
                (SELECT r.revealed_at FROM reveals r WHERE r.condition_id = c.id),
                c.title, c.description, c.image_url
           FROM conditions c WHERE c.id = ?1",
        [id],
        |r| {
            Ok(round_json(
                &r.get::<_, String>(0)?,
                public_status(&r.get::<_, String>(1)?),
                r.get::<_, Option<i64>>(2)?,
                match (r.get::<_, Option<i64>>(3)?, r.get::<_, Option<i64>>(4)?) {
                    (Some(c), Some(h)) => Some((c, h)),
                    _ => None,
                },
                &r.get::<_, Option<String>>(5)?,
                &Presentation {
                    title: r.get::<_, Option<String>>(10)?,
                    description: r.get::<_, Option<String>>(11)?,
                    image_url: r.get::<_, Option<String>>(12)?,
                },
                r.get::<_, i64>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, i64>(8)?,
                r.get::<_, Option<i64>>(9)?,
            ))
        },
    )
    .map_err(|_| Problem::missing("round"))
}

/// Only the fields that can change. An ETag over the whole body would churn on
/// nothing and make conditional requests useless.
fn etag(round: &Value) -> String {
    let mut h = Sha256::new();
    h.update(round["status"].to_string());
    h.update(round["seals"].to_string());
    h.update(round["slots_including_decoys"].to_string());
    h.update(round["opened_at"].to_string());
    format!("\"{}\"", &hex::encode(h.finalize())[..16])
}

fn reveal_payloads(app: &App, round_id: &str) -> Option<std::collections::HashMap<String, String>> {
    let conn = app.0.db.lock().unwrap();
    let blob: String = conn
        .query_row(
            "SELECT payloads_blob FROM reveals WHERE condition_id = ?1",
            [round_id],
            |r| r.get(0),
        )
        .ok()?;
    let slots: Vec<Value> = serde_json::from_str(&blob).ok()?;
    Some(
        slots
            .iter()
            .filter(|s| s["is_dummy"] != json!(true))
            .filter_map(|s| {
                Some((
                    s["ct_hash"].as_str()?.to_string(),
                    s["payload_b64"].as_str()?.to_string(),
                ))
            })
            .collect(),
    )
}

fn encode_cursor(created_at: i64, id: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!("{created_at}:{id}"))
}

fn decode_cursor(raw: &str) -> Result<(i64, String)> {
    let bad =
        || Problem::invalid("invalid_cursor", "that cursor is not one we issued").field("cursor");
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw.as_bytes())
        .map_err(|_| bad())?;
    let text = String::from_utf8(bytes).map_err(|_| bad())?;
    let (at, id) = text.split_once(':').ok_or_else(bad)?;
    Ok((at.parse().map_err(|_| bad())?, id.to_string()))
}

/// A stable fingerprint of the request a key was used with.
///
/// Taken over the parsed request rather than the raw bytes, so whitespace and
/// key order do not make a genuine retry look like a new request.
fn request_fingerprint<T: serde::Serialize>(req: &T) -> String {
    use sha2::{Digest, Sha256};
    let canonical = serde_json::to_string(req).unwrap_or_default();
    hex::encode(Sha256::digest(canonical.as_bytes()))
}

/// What a key already in the table means for this request.
enum Replay {
    /// Not seen, or expired. Carry on and create.
    Fresh,
    /// Seen with the same request. Hand back what was made the first time.
    Same(Box<Value>),
    /// Seen with a different request. That is a mistake, not a retry.
    Different,
}

fn replay(app: &App, key: &str, fingerprint: &str) -> Result<Replay> {
    let conn = app.0.db.lock().unwrap();
    let row: Option<(String, i64, Option<String>)> = conn
        .query_row(
            "SELECT response_json, created_at, request_hash FROM idempotency WHERE key = ?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    match row {
        Some((body, at, stored)) if unix_now() - at < IDEMPOTENCY_TTL_SECS => {
            // A row written before fingerprints existed matches anything, so
            // keys in flight across the deploy keep working.
            match stored {
                Some(hash) if hash != fingerprint => Ok(Replay::Different),
                _ => Ok(serde_json::from_str(&body)
                    .map(|v| Replay::Same(Box::new(v)))
                    .unwrap_or(Replay::Fresh)),
            }
        }
        _ => Ok(Replay::Fresh),
    }
}

fn remember(
    app: &App,
    key: &str,
    round_id: &str,
    body: &Value,
    fingerprint: &str,
    now: i64,
) -> Result<()> {
    let conn = app.0.db.lock().unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO idempotency
             (key, round_id, response_json, created_at, request_hash)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![key, round_id, body.to_string(), now, fingerprint],
    )
    .map_err(Problem::internal)?;
    Ok(())
}
