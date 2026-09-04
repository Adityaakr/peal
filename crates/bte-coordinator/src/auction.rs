//! Sealed bid auctions, as an API.
//!
//! Everything the create page at /#/create does, reachable from somebody else's
//! product. A round already gives the hard half: submissions nobody can read,
//! opening together on a deadline. An auction is that plus the rules that decide
//! what a bid MEANS, and those rules are the reason this exists rather than
//! being left to each caller:
//!
//!   - A bid is an integer of minor units in the auction's currency. Money in a
//!     float is a bug waiting for a rounding error.
//!   - A reserve and a maximum, both optional. Nothing is escrowed here, so a
//!     bid is cheap talk; the maximum is what stops a joke bid of ninety nine
//!     million taking an auction, and the result is a QUEUE so a bid nobody
//!     honours costs the seller one line rather than the sale.
//!   - Ranking is amount first, then batch position, and position comes from
//!     the ciphertext hashes rather than arrival order. So a tie cannot be won
//!     by bidding earlier, and the coordinator cannot reorder to pick a winner.
//!   - A bid naming a different auction is discarded. A ciphertext is not bound
//!     to a condition, so a blob posted to one auction can be replayed into
//!     another and will decrypt to the same bytes; the auction id inside the
//!     record is what makes that detectable.
//!
//! WHAT THIS DOES NOT DO, on purpose: it never sees a bid before the reveal.
//! Bids arrive as ciphertexts, exactly like any other seal, and the board below
//! is computed from the payloads the network already published.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::App;
use crate::v1::{Problem, Result};

/// Mirrors packages/live/src/record.ts. The layout is fixed width on purpose:
/// the ciphertext body is a keystream XOR, so a record that changed size with
/// the bid would put the bid's magnitude on the wire before anything opened.
const RECORD_V3: u8 = 3;
const RECORD_BYTES_V3: usize = 320;
const RECORD_V2: u8 = 2;
const RECORD_BYTES_V2: usize = 288;
const ORIGIN_BYTES: usize = 12;
const MAX_NAME_BYTES: usize = 48;
const MAX_AUCTION_ID_BYTES: usize = 64;
/// The ceiling a bid cannot exceed, so the value stays exactly representable
/// once it comes back out of a u64 as a JSON number.
const MAX_AMOUNT_MINOR: u64 = 1_000_000_000_000;

#[derive(Debug, Clone)]
pub struct BidRecord {
    pub auction_id: String,
    pub amount_minor: u64,
    pub name: String,
    pub contact: Option<Vec<u8>>,
    pub origin: Option<(String, u64, u8)>,
}

/// Decode one revealed payload, or None if it is not a bid this format wrote.
///
/// Every rejection here is a bid that does not count, and a reveal is a batch of
/// payloads from strangers: one unparseable slot must never stop the rest of the
/// board from being computed.
pub fn decode_bid(bytes: &[u8]) -> Option<BidRecord> {
    let v2 = bytes.first() == Some(&RECORD_V2) && bytes.len() == RECORD_BYTES_V2;
    let v3 = bytes.first() == Some(&RECORD_V3) && bytes.len() == RECORD_BYTES_V3;
    if !v2 && !v3 {
        return None;
    }
    let pad_end = if v2 {
        RECORD_BYTES_V2
    } else {
        RECORD_BYTES_V3 - ORIGIN_BYTES
    };

    let amount = u64::from_be_bytes(bytes.get(1..9)?.try_into().ok()?);
    if amount == 0 || amount > MAX_AMOUNT_MINOR {
        return None;
    }

    let id_len = *bytes.get(9)? as usize;
    if id_len == 0 || id_len > MAX_AUCTION_ID_BYTES {
        return None;
    }
    let name_len_at = 10 + id_len;
    if name_len_at >= pad_end {
        return None;
    }
    let name_len = *bytes.get(name_len_at)? as usize;
    let name_end = name_len_at + 1 + name_len;
    if name_len > MAX_NAME_BYTES || name_end >= pad_end {
        return None;
    }
    let contact_len = *bytes.get(name_end)? as usize;
    let end = name_end + 1 + contact_len;
    if end > pad_end {
        return None;
    }
    // The padding must be zero. Otherwise one bid has many encodings and the
    // record becomes a place to smuggle bytes past a board that shows a name
    // and a number.
    if bytes.get(end..pad_end)?.iter().any(|b| *b != 0) {
        return None;
    }

    let origin = if v2 { None } else { read_origin(bytes)? };

    Some(BidRecord {
        auction_id: std::str::from_utf8(bytes.get(10..10 + id_len)?)
            .ok()?
            .to_string(),
        amount_minor: amount,
        name: std::str::from_utf8(bytes.get(name_len_at + 1..name_end)?)
            .ok()?
            .to_string(),
        contact: if contact_len == 0 {
            None
        } else {
            Some(bytes.get(name_end + 1..end)?.to_vec())
        },
        origin,
    })
}

/// `None` wrapped in `Some` means there is no origin block, which is valid.
/// `None` means the block is malformed, which is not.
#[allow(clippy::type_complexity)]
fn read_origin(bytes: &[u8]) -> Option<Option<(String, u64, u8)>> {
    let at = RECORD_BYTES_V3 - ORIGIN_BYTES;
    let code = bytes.get(at..at + 3)?;
    if code == [0, 0, 0] {
        // No conversion happened, so the whole block must be zero or this is a
        // second encoding of the same bid.
        return if bytes.get(at + 3..)?.iter().all(|b| *b == 0) {
            Some(None)
        } else {
            None
        };
    }
    if code.iter().any(|c| !c.is_ascii_uppercase()) {
        return None;
    }
    let amount = u64::from_be_bytes(bytes.get(at + 3..at + 11)?.try_into().ok()?);
    if amount == 0 || amount > MAX_AMOUNT_MINOR {
        return None;
    }
    let decimals = *bytes.get(at + 11)?;
    if decimals > 4 {
        return None;
    }
    Some(Some((
        String::from_utf8(code.to_vec()).ok()?,
        amount,
        decimals,
    )))
}

// ------------------------------------------------------------------ routes --

pub fn routes() -> Router<App> {
    Router::new()
        .route("/currencies", get(list_currencies))
        .route("/names/{name}", get(check_name))
        .route("/auctions", post(create_auction))
        .route("/auctions/{id}", get(get_auction))
        .route("/auctions/{id}/bids", post(place_bid))
        .route("/auctions/{id}/results", get(get_results))
}

#[derive(Deserialize)]
struct CreateAuction {
    title: Option<String>,
    description: Option<String>,
    image_url: Option<String>,
    closes_in: Option<i64>,
    closes_at: Option<Value>,
    /// ISO 4217, or any label the caller ranks in. Not interpreted beyond being
    /// carried, so a caller settling in something that is not a currency can.
    currency: Option<String>,
    /// Minor units per major. 2 for dollars, 0 for yen, 3 for a dinar.
    decimals: Option<i64>,
    /// Both in MINOR units, so no bid can carry a rounding error.
    reserve_minor: Option<i64>,
    maximum_minor: Option<i64>,
    /// The seller's public key, when bidders may attach contact details. The
    /// private half must never come here; see the note on the response.
    contact_public_key: Option<String>,
    tag: Option<String>,
}

async fn create_auction(
    State(app): State<App>,
    headers: HeaderMap,
    Json(req): Json<CreateAuction>,
) -> Result<Response> {
    let currency = req.currency.unwrap_or_else(|| "USD".into());
    if currency.trim().is_empty() || currency.chars().count() > 12 {
        return Err(
            Problem::invalid("invalid_currency", "a currency is 1 to 12 characters")
                .field("currency"),
        );
    }
    // Known currency, canonical spelling: "usd" and "USD" are one currency, and
    // the auction stores the code the rest of the world writes.
    let known = crate::currency::find(&currency);
    let currency = known.map_or_else(|| currency.trim().to_string(), |c| c.code.to_string());

    // Decimals come from the currency unless the caller overrides them. This is
    // the difference between an API you have to look things up for and one that
    // knows the yen has none. An unrecognised code still works; it just has to
    // say how many places it has.
    let decimals = match (req.decimals, known) {
        (Some(d), _) => d,
        (None, Some(c)) => c.decimals,
        (None, None) => 2,
    };
    if !(0..=4).contains(&decimals) {
        return Err(
            Problem::invalid("invalid_decimals", "decimals must be 0 to 4").field("decimals"),
        );
    }
    for (value, field, code) in [
        (req.reserve_minor, "reserve_minor", "invalid_reserve"),
        (req.maximum_minor, "maximum_minor", "invalid_maximum"),
    ] {
        if let Some(v) = value {
            if v < 0 || v as u64 > MAX_AMOUNT_MINOR {
                return Err(Problem::invalid(
                    code,
                    "must be a whole number of minor units inside the ceiling",
                )
                .field(field));
            }
        }
    }
    if let (Some(r), Some(m)) = (req.reserve_minor, req.maximum_minor) {
        if m < r {
            return Err(Problem::invalid(
                "invalid_maximum",
                "the maximum cannot be below the reserve",
            )
            .field("maximum_minor"));
        }
    }

    let round = crate::v1::create_round_inner(
        &app,
        headers,
        crate::v1::RoundSpec {
            opens_at: req.closes_at,
            opens_in: req.closes_in,
            tag: req.tag,
            title: req.title,
            description: req.description,
            image_url: req.image_url,
        },
    )
    .await?;
    let id = round["id"].as_str().unwrap_or_default().to_string();

    {
        let conn = app.0.db.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO auctions
               (condition_id, currency, decimals, reserve_minor, maximum_minor, contact_public_key)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                id,
                currency,
                decimals,
                req.reserve_minor,
                req.maximum_minor,
                req.contact_public_key
            ],
        )
        .map_err(Problem::internal)?;
    }

    let body = auction_json(&app, &id)?;
    Ok((StatusCode::CREATED, Json(body)).into_response())
}

/// GET /v1/names/{name}
///
/// Whether a short link is free, and where it points if it is not.
///
/// READING ONLY, AND DELIBERATELY. Claiming a name is a permanent onchain
/// write that can never be undone or repointed: a name spent is spent. This
/// server will tell you whether one is available and what it resolves to; it
/// will not spend one on your behalf, because a bug here would burn something
/// nobody can give back. Claim it from your own key, or from the create page.
async fn check_name(State(app): State<App>, Path(name): Path<String>) -> Result<Json<Value>> {
    let valid = crate::names::is_valid_name(&name);
    if !valid {
        return Ok(Json(json!({
            "name": name,
            "valid": false,
            "available": false,
            "detail": "3 to 32 characters of a-z, 0-9 and hyphens, not starting or ending with one",
        })));
    }

    let url = app
        .0
        .cfg
        .rpc_urls
        .get(&crate::names::TEMPO_CHAIN_ID)
        .cloned()
        .unwrap_or_else(|| crate::names::TEMPO_RPC_FALLBACK.to_string());

    match crate::names::resolve(&app.0.http, &url, &name).await {
        Ok(found) => Ok(Json(json!({
            "name": name,
            "valid": true,
            "available": found.is_none(),
            "url": format!("https://peal.network/{name}"),
            "registry": crate::names::PEAL_NAMES,
            "permanent": true,
        }))),
        // A registry we cannot reach is not an available name. Saying "free"
        // because a lookup timed out would send somebody to claim one that is
        // already taken.
        Err(e) => Err(Problem::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "registry_unreachable",
            format!("could not reach the name registry: {e}"),
        )),
    }
}

#[derive(Deserialize)]
struct CurrencyQuery {
    q: Option<String>,
    limit: Option<usize>,
}

/// GET /v1/currencies
///
/// The same list the create page offers, so a caller can build the same picker
/// instead of hard-coding twelve codes and getting the decimals wrong.
async fn list_currencies(
    axum::extract::Query(q): axum::extract::Query<CurrencyQuery>,
) -> Json<Value> {
    let limit = q.limit.unwrap_or(200).clamp(1, 200);
    let found = crate::currency::search(q.q.as_deref().unwrap_or(""), limit);
    Json(json!({
        "data": found.iter().map(|c| crate::currency::to_json(c)).collect::<Vec<_>>(),
        "total": crate::currency::CURRENCIES.len(),
    }))
}

async fn get_auction(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Value>> {
    Ok(Json(auction_json(&app, &id)?))
}

/// A bid is a ciphertext, like every other seal. This endpoint exists so the
/// path reads as an auction rather than to do anything different.
async fn place_bid(
    State(app): State<App>,
    Path(id): Path<String>,
    body: Json<Value>,
) -> Result<Response> {
    crate::v1::create_seal_inner(&app, &id, body.0).await
}

async fn get_results(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Value>> {
    let auction = auction_json(&app, &id)?;
    if auction["status"] != "opened" {
        return Ok(Json(json!({
            "auction_id": id,
            "status": auction["status"],
            "bids": Value::Null,
            "detail": "the auction has not opened yet; nothing is readable until it does",
        })));
    }

    let (reserve, maximum) = (
        auction["reserve_minor"].as_i64(),
        auction["maximum_minor"].as_i64(),
    );

    let slots = crate::v1::reveal_slots(&app, &id).unwrap_or_default();
    let mut bids: Vec<Value> = Vec::new();
    let mut discarded: Vec<Value> = Vec::new();

    for slot in &slots {
        if slot["is_dummy"] == json!(true) {
            continue;
        }
        let Some(b64) = slot["payload_b64"].as_str() else {
            continue;
        };
        let Ok(bytes) = base64_decode(b64) else {
            continue;
        };
        let position = slot["position"].as_i64().unwrap_or(0);
        let ct_hash = slot["ct_hash"].as_str().unwrap_or_default().to_string();

        match decode_bid(&bytes) {
            None => discarded.push(json!({"ct_hash": ct_hash, "reason": "unreadable"})),
            // A ciphertext is not bound to a condition, so a blob posted to one
            // auction can be replayed into another. The id inside the record is
            // what makes that detectable.
            Some(bid) if bid.auction_id != id => {
                discarded.push(json!({"ct_hash": ct_hash, "reason": "other-auction"}))
            }
            Some(bid) => {
                let amount = bid.amount_minor as i64;
                bids.push(json!({
                    "ct_hash": ct_hash,
                    "position": position,
                    "name": bid.name,
                    "amount_minor": amount,
                    "meets_reserve": reserve.is_none_or(|r| amount >= r),
                    "within_maximum": maximum.is_none_or(|m| amount <= m),
                    "sealed_contact_b64": bid.contact.as_ref().map(|c| base64_encode(c)),
                    "bid_in": bid.origin.as_ref().map(|(code, amt, dec)| json!({
                        "currency": code, "amount_minor": amt, "decimals": dec,
                    })),
                }));
            }
        }
    }

    // Amount first, then batch position. Position comes from the ciphertext
    // hashes rather than arrival order, so a tie cannot be won by bidding
    // earlier and the coordinator cannot reorder to choose a winner.
    bids.sort_by(|a, b| {
        b["amount_minor"]
            .as_i64()
            .cmp(&a["amount_minor"].as_i64())
            .then(a["position"].as_i64().cmp(&b["position"].as_i64()))
    });

    // A QUEUE, not a winner. Nothing is escrowed, so a bid nobody honours should
    // cost the seller one line rather than the sale.
    let queue: Vec<Value> = bids
        .iter()
        .filter(|b| b["meets_reserve"] == json!(true) && b["within_maximum"] == json!(true))
        .cloned()
        .collect();

    Ok(Json(json!({
        "auction_id": id,
        "status": "opened",
        "currency": auction["currency"],
        "decimals": auction["decimals"],
        "bids": bids,
        "queue": queue,
        "winner": queue.first().cloned().unwrap_or(Value::Null),
        "decoys": slots.iter().filter(|s| s["is_dummy"] == json!(true)).count(),
        "discarded": discarded,
    })))
}

/// The auction rules stored beside a round.
type Rules = (String, i64, Option<i64>, Option<i64>, Option<String>);

fn auction_json(app: &App, id: &str) -> Result<Value> {
    let mut round = crate::v1::round_value(app, id)?;
    let conn = app.0.db.lock().unwrap();
    let row: Option<Rules> = conn
        .query_row(
            "SELECT currency, decimals, reserve_minor, maximum_minor, contact_public_key
               FROM auctions WHERE condition_id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .ok();
    let Some((currency, decimals, reserve, maximum, contact)) = row else {
        return Err(Problem::missing("auction"));
    };

    let obj = round.as_object_mut().unwrap();
    // Renamed for the domain: a round opens, an auction closes to bidding and
    // then its results open. Same instant, and calling it "opens_at" on an
    // auction reads as when bidding starts.
    let closes_at = obj.remove("opens_at").unwrap_or(Value::Null);
    let closes_at_unix = obj.remove("opens_at_unix").unwrap_or(Value::Null);
    obj.remove("seals_url");
    let bids = obj.remove("seals").unwrap_or(json!(0));
    obj.insert("closes_at".into(), closes_at);
    obj.insert("closes_at_unix".into(), closes_at_unix);
    obj.insert("bids".into(), bids);
    obj.insert("currency".into(), json!(currency));
    obj.insert("decimals".into(), json!(decimals));
    obj.insert("reserve_minor".into(), json!(reserve));
    obj.insert("maximum_minor".into(), json!(maximum));
    obj.insert("contact_public_key".into(), json!(contact));
    obj.insert("bids_url".into(), json!(format!("/v1/auctions/{id}/bids")));
    obj.insert(
        "results_url".into(),
        json!(format!("/v1/auctions/{id}/results")),
    );

    // A page bidders can open, so an auction is usable before anybody has built
    // an interface for it. Null when the auction has no title, because a page
    // with nothing on it is worse than no page.
    let origin = std::env::var("PEAL_ORIGIN").unwrap_or_else(|_| "https://peal.network".into());
    let snapshot = Value::Object(obj.clone());
    match canonical_terms(id, &snapshot) {
        Some(canonical) => {
            obj.insert("bid_url".into(), json!(live_link(&origin, &canonical)));
            // The code a bidder checks against what the seller told them, and
            // the hash a caller anchors on chain. Both from the same bytes as
            // the link, so the three cannot describe different auctions.
            obj.insert("check_code".into(), json!(check_code(&canonical)));
            obj.insert("terms_hash".into(), json!(terms_hash(&canonical)));
        }
        None => {
            obj.insert("bid_url".into(), Value::Null);
            obj.insert("check_code".into(), Value::Null);
            obj.insert("terms_hash".into(), Value::Null);
        }
    }
    Ok(round)
}

/// The auction as Peal Live terms, so it has a page bidders can actually use.
///
/// An auction created through the API otherwise has nowhere to send anybody:
/// the developer would have to build a bidding interface before their first
/// test. These are the same terms the create page produces, packed the same
/// way, so the hosted page renders an API auction exactly like one made here.
///
/// The whole auction rides in the URL fragment, which browsers never send to a
/// server. That is the property the link has always had and it is unchanged:
/// nobody, including us, learns which auction a bidder opened.
///
/// Mirrors `canonicalTerms` in packages/live/src/terms.ts. The tuple is
/// positional and its order is the format, so it is written out longhand here
/// rather than assembled from a map.
const TERMS_VERSION: i64 = 5;

/// The canonical terms bytes: the link, the check code and the hash all come
/// from these, so the three can never describe different auctions.
fn canonical_terms(id: &str, a: &Value) -> Option<Vec<u8>> {
    let text = |k: &str| {
        a[k].as_str()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let wire = json!([
        TERMS_VERSION,
        id,
        text("title")?,
        a["currency"].as_str()?,
        a["decimals"].as_i64()?,
        a["closes_at_unix"].as_i64()?,
        a["reserve_minor"].as_i64(),
        a["maximum_minor"].as_i64(),
        text("image_url"),
        text("description"),
        a["contact_public_key"].as_str(),
    ]);
    Some(serde_json::to_string(&wire).ok()?.into_bytes())
}

fn live_link(origin: &str, canonical: &[u8]) -> String {
    format!("{origin}/#/live/{}", b64url(canonical))
}

/// sha256 over the canonical terms, as 0x hex. This is what a caller anchors on
/// chain: it commits to every field at once, so a link whose reserve or close
/// time was edited hashes to something else.
fn terms_hash(canonical: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("0x{}", hex::encode(Sha256::digest(canonical)))
}

/// Crockford's alphabet: no I, L, O or U, so nothing here can be misheard as
/// something else when it is read off a screen.
const BASE32: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A short, speakable fingerprint of the terms.
///
/// Forty bits, which is not a cryptographic commitment and is not trying to be.
/// It exists so a bidder can hear "3QK7 M2WD" read out and see the same eight
/// characters on their own screen: its threat model is a swapped link, not a
/// determined collision search.
///
/// Must agree exactly with `checksum` in packages/live/src/terms.ts. A check
/// code that differs from the one the page shows is worse than none, because it
/// tells somebody they are on the wrong auction when they are not.
fn check_code(canonical: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(canonical);
    let mut bits: u64 = 0;
    for byte in digest.iter().take(5) {
        bits = (bits << 8) | u64::from(*byte);
    }
    // Least significant group first. The TypeScript builds this string by
    // PREPENDING while counting down, which lands the low five bits at index 0;
    // appending while counting down produces the exact reverse, and a reversed
    // check code tells a bidder they are on the wrong auction when they are not.
    let mut out = String::new();
    for i in 0..8 {
        out.push(BASE32[((bits >> (i * 5)) & 31) as usize] as char);
    }
    format!("{} {}", &out[..4], &out[4..])
}

fn b64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn base64_decode(s: &str) -> std::result::Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s)
}

fn base64_encode(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(b)
}
