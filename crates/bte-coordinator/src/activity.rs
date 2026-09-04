//! What the network has actually done, for the activity page.
//!
//! WHAT IS COUNTED, AND WHAT IS NOT. Everything here is derived from rows the
//! coordinator already writes plus one counters table for things that leave no
//! other trace. There is no visitor tracking, no session, no address, no agent
//! string, no cookie: a page view is not counted because nothing counts one, and
//! a number nobody can produce is worse than a missing one.
//!
//! So "users" is not a column here and never will be. There are no accounts on
//! this network, which is the point of it. What can be counted honestly is WORK:
//! rounds opened, payloads sealed, batches opened, how long opening took, and
//! which tags that work arrived under.

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::{internal, ApiError};
use crate::db::unix_now;
use crate::state::App;

const MAX_DAYS: i64 = 90;
const DEFAULT_DAYS: i64 = 30;

#[derive(Deserialize)]
pub struct ActivityQuery {
    days: Option<i64>,
}

/// Bump a daily counter. Never fails a request: a missed count is a worse
/// outcome than a 500, but only slightly, and the caller is doing something
/// real that should not break because a statistic could not be written.
pub fn count(app: &App, kind: &str) {
    let day = crate::pages::today();
    let conn = app.0.db.lock().unwrap();
    let _ = conn.execute(
        "INSERT INTO counters (kind, day, count) VALUES (?1, ?2, 1)
         ON CONFLICT(kind, day) DO UPDATE SET count = count + 1",
        rusqlite::params![kind, day],
    );
}

/// Where a request was served from, without ever handling an address.
///
/// The edge that terminated TLS already knows roughly where the caller is, and
/// says so in a header. Reading that is the whole implementation: no IP is
/// parsed, no IP is stored, no GeoIP database is consulted and no third party
/// is asked. The resolution is a handful of metros rather than a city, which is
/// the right resolution for "who is using this" and the wrong one for following
/// anybody.
///
/// The alternative, resolving x-forwarded-for against a GeoIP database, would
/// mean the coordinator handling visitor addresses to draw a chart. On a
/// product whose entire claim is that it cannot read what you send it, that is
/// not a trade worth making for a nicer map.
fn region_of(headers: &axum::http::HeaderMap) -> String {
    // cf-ipcountry first, so putting Cloudflare in front upgrades this to real
    // country resolution with no code change.
    if let Some(cc) = headers.get("cf-ipcountry").and_then(|v| v.to_str().ok()) {
        let cc = cc.trim().to_uppercase();
        if cc.len() == 2 && cc.chars().all(|c| c.is_ascii_alphabetic()) {
            return cc;
        }
    }
    for name in ["x-railway-edge", "x-vercel-ip-country", "fly-region"] {
        if let Some(v) = headers.get(name).and_then(|v| v.to_str().ok()) {
            let v: String = v
                .trim()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
                .take(16)
                .collect();
            if !v.is_empty() {
                return v.to_lowercase();
            }
        }
    }
    "unknown".to_string()
}

/// Which part of the API a path belongs to, for the endpoint breakdown.
///
/// A family rather than a route: `/v1/rounds/{id}/seals` counts as seals, and
/// ids never enter a counter key. A key built from a path with an id in it
/// would be an unbounded set of rows and a record of which specific round
/// somebody read.
fn family_of(path: &str) -> Option<&'static str> {
    let rest = path
        .strip_prefix("/v1/x402/")
        .or_else(|| path.strip_prefix("/v1/"))
        .or_else(|| path.strip_prefix("/v0/"))?;
    let head = rest.split('/').next().unwrap_or_default();
    // Reading the dashboard is not using the API. Without this the activity
    // page's own polling, every fifteen seconds per open tab, becomes the
    // busiest endpoint on the chart it is drawing.
    const OBSERVABILITY: [&str; 5] = ["activity", "stats", "healthz", "x402", "skill-installs"];
    if OBSERVABILITY.contains(&head) {
        return None;
    }
    // A fixed set, so a caller cannot mint counter rows by inventing paths.
    const FAMILIES: [&str; 10] = [
        "rounds",
        "seals",
        "auctions",
        "parameters",
        "currencies",
        "names",
        "intents",
        "conditions",
        "ciphertexts",
        "committees",
    ];
    if rest.is_empty() {
        return Some("service");
    }
    FAMILIES.into_iter().find(|f| *f == head)
}

/// Counts a call and where it came from. Nothing else about the request.
pub async fn observe(
    State(app): State<App>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    if req.method() == axum::http::Method::OPTIONS {
        return next.run(req).await;
    }
    let family = family_of(req.uri().path());
    let region = family.map(|_| region_of(req.headers()));
    let res = next.run(req).await;

    if let (Some(family), Some(region)) = (family, region) {
        // Errors are counted apart from work. A developer hammering a 400 is
        // doing something, and a chart that hides it is hiding the thing most
        // worth fixing.
        let ok = res.status().as_u16() < 400;
        count(&app, &format!("call:{family}"));
        if !ok {
            count(&app, &format!("err:{family}"));
        }
        count(&app, &format!("region:{region}"));
    }
    res
}

/// GET /v1/activity
pub async fn get_activity(
    State(app): State<App>,
    Query(q): Query<ActivityQuery>,
) -> Result<Json<Value>, ApiError> {
    let days = q.days.unwrap_or(DEFAULT_DAYS).clamp(1, MAX_DAYS);
    let since = unix_now() - days * 86_400;
    let conn = app.0.db.lock().unwrap();

    let one = |sql: &str| -> Result<i64, ApiError> {
        conn.query_row(sql, [], |r| r.get::<_, i64>(0))
            .map_err(internal)
    };

    // ---- totals, over all time --------------------------------------------
    let totals = json!({
        "rounds": one("SELECT COUNT(*) FROM conditions")?,
        "opened": one("SELECT COUNT(*) FROM conditions WHERE status = 'revealed'")?,
        "open": one("SELECT COUNT(*) FROM conditions WHERE status = 'pending'")?,
        "sealed": one("SELECT COUNT(*) FROM ciphertexts WHERE is_dummy = 0")?,
        "decoys": one("SELECT COUNT(*) FROM ciphertexts WHERE is_dummy = 1")?,
        "batches": one("SELECT COUNT(*) FROM batches WHERE finalized_at IS NOT NULL")?,
        "shares": one("SELECT COUNT(*) FROM shares WHERE verified = 1")?,
        "auctions": one("SELECT COUNT(*) FROM auctions")?,
        "skill_installs": one("SELECT COALESCE(SUM(count), 0) FROM counters WHERE kind = 'skill_install'")?,
        "paid_calls": one("SELECT COUNT(*) FROM x402_payments")?,
    });

    // ---- a day by day series, with the empty days present ------------------
    //
    // A chart that omits quiet days draws a line through them and implies
    // activity that did not happen, so every day in the window is emitted.
    let mut series: Vec<Value> = Vec::new();
    for back in (0..days).rev() {
        let start = unix_now() - back * 86_400;
        let day_start = start - start.rem_euclid(86_400);
        let day_end = day_start + 86_400;
        let day = crate::pages::day_of(day_start);

        let count_between = |table: &str, extra: &str| -> i64 {
            conn.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE created_at >= ?1 AND created_at < ?2 {extra}"),
                [day_start, day_end],
                |r| r.get(0),
            )
            .unwrap_or(0)
        };
        let opened: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM reveals WHERE revealed_at >= ?1 AND revealed_at < ?2",
                [day_start, day_end],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let paid: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM x402_payments WHERE redeemed_at >= ?1 AND redeemed_at < ?2",
                [day_start, day_end],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let calls: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(count), 0) FROM counters
                  WHERE kind LIKE 'call:%' AND day = ?1",
                [&day],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let installs: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(count), 0) FROM counters WHERE kind = 'skill_install' AND day = ?1",
                [&day],
                |r| r.get(0),
            )
            .unwrap_or(0);

        series.push(json!({
            "day": day,
            "rounds": count_between("conditions", ""),
            "sealed": count_between("ciphertexts", "AND is_dummy = 0"),
            "opened": opened,
            "skill_installs": installs,
            "paid_calls": paid,
            "calls": calls,
        }));
    }

    // ---- how long opening a batch takes -----------------------------------
    //
    // Percentiles rather than a mean: one slow batch drags a mean somewhere no
    // batch ever was, and the number people care about is the one most opens
    // beat.
    let mut timings: Vec<i64> = {
        let mut stmt = conn
            .prepare(
                "SELECT predecrypt_ms + finalize_ms FROM batches
                  WHERE finalized_at IS NOT NULL
                    AND predecrypt_ms IS NOT NULL AND finalize_ms IS NOT NULL",
            )
            .map_err(internal)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, i64>(0))
            .map_err(internal)?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        rows
    };
    timings.sort_unstable();
    let pct = |p: f64| -> Value {
        if timings.is_empty() {
            return Value::Null;
        }
        let idx = (((timings.len() - 1) as f64) * p).round() as usize;
        json!(timings[idx])
    };

    // ---- where calls came from, and which part of the API they hit ---------
    //
    // Summed over the window from the same counters table. Both are keyed by a
    // fixed vocabulary, so the row count is bounded no matter what anyone sends.
    let since_day = crate::pages::day_of(since);
    let sum_prefix = |prefix: &str| -> Vec<(String, i64)> {
        let mut stmt = match conn.prepare(
            "SELECT kind, SUM(count) FROM counters
              WHERE kind LIKE ?1 AND day >= ?2
              GROUP BY kind ORDER BY SUM(count) DESC LIMIT 40",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(rusqlite::params![format!("{prefix}%"), &since_day], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map(|rows| {
            rows.filter_map(Result::ok)
                .map(|(k, n)| (k[prefix.len()..].to_string(), n))
                .collect()
        })
        .unwrap_or_default()
    };

    let regions: Vec<Value> = sum_prefix("region:")
        .into_iter()
        .map(|(code, calls)| json!({ "code": code, "calls": calls }))
        .collect();

    let errors: std::collections::HashMap<String, i64> = sum_prefix("err:").into_iter().collect();
    let endpoints: Vec<Value> = sum_prefix("call:")
        .into_iter()
        .map(|(family, calls)| {
            json!({
                "family": family.clone(),
                "calls": calls,
                "errors": errors.get(&family).copied().unwrap_or(0),
            })
        })
        .collect();
    let calls_total: i64 = endpoints
        .iter()
        .filter_map(|e| e.get("calls").and_then(Value::as_i64))
        .sum();

    // ---- what is being built ----------------------------------------------
    let mut stmt = conn
        .prepare(
            "SELECT c.tag, COUNT(*), MAX(c.created_at),
                    SUM(CASE WHEN c.created_at >= ?1 THEN 1 ELSE 0 END)
               FROM conditions c
              WHERE c.tag IS NOT NULL AND c.tag <> ''
              GROUP BY c.tag ORDER BY COUNT(*) DESC LIMIT 12",
        )
        .map_err(internal)?;
    let tags: Vec<Value> = stmt
        .query_map([since], |r| {
            Ok(json!({
                "tag": r.get::<_, String>(0)?,
                "rounds": r.get::<_, i64>(1)?,
                "last_seen": r.get::<_, i64>(2)?,
                "recent": r.get::<_, i64>(3)?,
            }))
        })
        .map_err(internal)?
        .filter_map(Result::ok)
        .collect();

    Ok(Json(json!({
        "days": days,
        "as_of": unix_now(),
        "totals": totals,
        "series": series,
        "open_ms": {
            "p50": pct(0.5), "p90": pct(0.9), "p99": pct(0.99),
            "samples": timings.len(),
        },
        // The raw samples, so the page can draw the shape rather than only three
        // numbers from it. Capped: past a couple of thousand points a histogram
        // does not get more truthful, only heavier to send.
        "timings": timings.iter().rev().take(2000).collect::<Vec<_>>(),
        "tags": tags,
        "regions": regions,
        "endpoints": endpoints,
        "calls": calls_total,
        "counts_note": "Work, not people. There are no accounts on this network, so nothing here counts visitors, sessions or addresses.",
    })))
}

/// POST /v0/skill-installs
///
/// Called by the last line of the installer, after the files have landed. It
/// takes no body, reads no header, and stores nothing but +1 against today.
/// That makes it worth roughly what it costs: anyone can curl it, so treat the
/// number as a floor on real installs rather than a headcount. It is still the
/// honest version, because the alternatives all involve keeping something about
/// the person who ran it.
pub async fn skill_installed(State(app): State<App>) -> Json<Value> {
    count(&app, "skill_install");
    Json(json!({"ok": true}))
}
