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
        "tags": tags,
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
