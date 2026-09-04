//! What the network is actually being used for.
//!
//! `/v0/conditions` is capped at a hundred rows, so anything counting from it
//! stops being true the moment the network is busy, which is exactly when the
//! number matters. This aggregates in SQL over everything instead.
//!
//! THE UNIT OF ATTRIBUTION IS THE TAG, and it already existed: `create_condition`
//! takes an optional client label the coordinator does not interpret. An app
//! passing `tag: "my-app"` is saying "this one is mine", and that is the only
//! identity the network has. There are no keys and no accounts, so this counts
//! WORK, not people. A leaderboard that said "47 developers" would be inventing
//! a number nothing here can know; one that says "47 conditions under this tag"
//! is reporting a row count.
//!
//! Which also means a tag is a claim, not a credential. Anyone can send any
//! label, including one that is already on the board. It is a directory of what
//! is being built, not a ranking anything is staked on, and the page says so.

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::{internal, ApiError};
use crate::db::unix_now;
use crate::state::App;

/// The longest window a caller may ask about. A year of seconds is plenty for
/// "recently" and stops a caller asking for a scan over all of time on every
/// page load.
const MAX_WINDOW_SECS: i64 = 366 * 24 * 60 * 60;
const DEFAULT_WINDOW_SECS: i64 = 24 * 60 * 60;
/// Tags returned. Enough to be a directory, bounded so one caller cannot ask
/// the coordinator to serialise every label ever sent.
const MAX_TAGS: usize = 50;

#[derive(Deserialize)]
pub struct StatsQuery {
    /// How far back "recent" reaches, in seconds.
    window_secs: Option<i64>,
}

#[derive(Serialize)]
struct TagRow {
    tag: String,
    conditions: i64,
    /// Sealed by callers. Excludes the padding the coordinator adds itself,
    /// which would otherwise make a quiet tag look busy: every condition is
    /// padded to a multiple of the batch size whether or not anyone used it.
    ciphertexts: i64,
    revealed: i64,
    first_seen: i64,
    last_seen: i64,
    /// Conditions created inside the window.
    recent: i64,
}

/// GET /v0/stats
pub async fn get_stats(
    State(app): State<App>,
    Query(q): Query<StatsQuery>,
) -> Result<Json<Value>, ApiError> {
    let window = q
        .window_secs
        .unwrap_or(DEFAULT_WINDOW_SECS)
        .clamp(60, MAX_WINDOW_SECS);
    let since = unix_now() - window;

    let conn = app.0.db.lock().unwrap();

    let one = |sql: &str| -> Result<i64, ApiError> {
        conn.query_row(sql, [], |r| r.get::<_, i64>(0))
            .map_err(internal)
    };

    let conditions = one("SELECT COUNT(*) FROM conditions")?;
    let revealed = one("SELECT COUNT(*) FROM conditions WHERE status = 'revealed'")?;
    let pending = one("SELECT COUNT(*) FROM conditions WHERE status = 'pending'")?;
    // Real ciphertexts only. The dummies are the coordinator's own padding and
    // counting them as usage would be counting our own work as somebody's.
    let sealed = one("SELECT COUNT(*) FROM ciphertexts WHERE is_dummy = 0")?;
    let padding = one("SELECT COUNT(*) FROM ciphertexts WHERE is_dummy = 1")?;

    let recent_conditions: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM conditions WHERE created_at >= ?1",
            [since],
            |r| r.get(0),
        )
        .map_err(internal)?;
    let recent_sealed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ciphertexts WHERE is_dummy = 0 AND created_at >= ?1",
            [since],
            |r| r.get(0),
        )
        .map_err(internal)?;

    // How long the network actually takes to open a batch, from its own
    // records rather than from a claim in a document.
    let median_ms: Option<i64> = conn
        .query_row(
            "SELECT (predecrypt_ms + finalize_ms) FROM batches
             WHERE finalized_at IS NOT NULL AND predecrypt_ms IS NOT NULL
               AND finalize_ms IS NOT NULL
             ORDER BY (predecrypt_ms + finalize_ms)
             LIMIT 1 OFFSET (
               SELECT COUNT(*) / 2 FROM batches
               WHERE finalized_at IS NOT NULL AND predecrypt_ms IS NOT NULL
                 AND finalize_ms IS NOT NULL
             )",
            [],
            |r| r.get(0),
        )
        .ok();

    let mut stmt = conn
        .prepare(
            "SELECT c.tag,
                    COUNT(DISTINCT c.id),
                    (SELECT COUNT(*) FROM ciphertexts x
                      JOIN conditions c2 ON c2.id = x.condition_id
                     WHERE c2.tag IS c.tag AND x.is_dummy = 0),
                    SUM(CASE WHEN c.status = 'revealed' THEN 1 ELSE 0 END),
                    MIN(c.created_at),
                    MAX(c.created_at),
                    SUM(CASE WHEN c.created_at >= ?1 THEN 1 ELSE 0 END)
               FROM conditions c
              WHERE c.tag IS NOT NULL AND c.tag <> ''
              GROUP BY c.tag
              ORDER BY COUNT(DISTINCT c.id) DESC, MAX(c.created_at) DESC
              LIMIT ?2",
        )
        .map_err(internal)?;

    let rows = stmt
        .query_map(rusqlite::params![since, MAX_TAGS as i64], |r| {
            Ok(TagRow {
                tag: r.get(0)?,
                conditions: r.get(1)?,
                ciphertexts: r.get(2)?,
                revealed: r.get(3)?,
                first_seen: r.get(4)?,
                last_seen: r.get(5)?,
                recent: r.get(6)?,
            })
        })
        .map_err(internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(internal)?;

    Ok(Json(json!({
        "totals": {
            "conditions": conditions,
            "revealed": revealed,
            "pending": pending,
            "sealed": sealed,
            "padding": padding,
        },
        "window_secs": window,
        "recent": {
            "conditions": recent_conditions,
            "sealed": recent_sealed,
        },
        "median_open_ms": median_ms,
        "tags": rows,
        "as_of": unix_now(),
    })))
}
