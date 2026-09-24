//! Condition engine: fire -> freeze (pad, position, pipeline pre_decrypt) ->
//! collect shares -> finalize -> reveal. Stall detection for liveness.

use anyhow::{Context, Result};
use rusqlite::OptionalExtension;
use serde::Serialize;
use std::sync::Arc;
use tracing::{info, warn};

use crate::db::{now_ms, unix_now};
use crate::merkle;
use crate::scheme::{self, AnyShare, CrossTerms, Sealed};
use crate::state::App;

/// One revealed slot, stored as JSON in reveals.payloads_blob.
#[derive(Serialize, serde::Deserialize)]
pub struct RevealSlot {
    pub position: u32,
    pub ct_hash: String,
    pub is_dummy: bool,
    pub valid: bool,
    pub payload_b64: String,
}

/// One engine pass. Called on an interval by main, and directly by tests.
pub async fn tick(app: &App) -> Result<()> {
    let now = unix_now();

    let due: Vec<(String, String)> = {
        let conn = app.0.db.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, committee_id FROM conditions
             WHERE status = 'pending' AND kind = 'at_time' AND fires_at <= ?1",
        )?;
        let rows = stmt.query_map([now], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    for (condition_id, committee_id) in due {
        if let Err(e) = freeze_condition(app, &condition_id, &committee_id).await {
            warn!(condition_id, error = %e, "freeze failed");
        }
    }

    fire_at_block(app).await?;
    finalize_ready(app).await?;
    mark_stalled(app)?;
    crate::dkg::tick(app)?;
    Ok(())
}

/// at_block conditions: poll each referenced chain's head via JSON-RPC and
/// fire conditions whose target height has passed. Reuses the exact
/// freeze/reveal machinery as at_time.
async fn fire_at_block(app: &App) -> Result<()> {
    let pending: Vec<(String, String, i64, i64)> = {
        let conn = app.0.db.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, committee_id, chain_id, height FROM conditions
             WHERE status = 'pending' AND kind = 'at_block'",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    if pending.is_empty() {
        return Ok(());
    }

    let mut heads: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    for chain_id in pending
        .iter()
        .map(|(_, _, c, _)| *c)
        .collect::<std::collections::HashSet<_>>()
    {
        let Some(url) = app.0.cfg.rpc_urls.get(&chain_id) else {
            continue; // no RPC configured; condition stays pending
        };
        match block_number(&app.0.http, url).await {
            Ok(height) => {
                heads.insert(chain_id, height);
            }
            Err(e) => warn!(chain_id, error = %e, "eth_blockNumber failed"),
        }
    }

    for (condition_id, committee_id, chain_id, height) in pending {
        if heads.get(&chain_id).is_some_and(|head| *head >= height) {
            tracing::info!(condition_id, chain_id, height, "at_block condition fired");
            if let Err(e) = freeze_condition(app, &condition_id, &committee_id).await {
                warn!(condition_id, error = %e, "freeze failed");
            }
        }
    }
    Ok(())
}

async fn block_number(client: &reqwest::Client, url: &str) -> Result<i64> {
    let resp: serde_json::Value = client
        .post(url)
        .json(&serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []
        }))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let hex = resp["result"]
        .as_str()
        .context("eth_blockNumber returned no result")?;
    i64::from_str_radix(hex.trim_start_matches("0x"), 16).context("bad block number hex")
}

/// Freeze: add the scheme's decoys (v0 pads to a multiple of B; v1 adds one),
/// assign positions, create batch rows, spawn pre_decrypt per batch
/// (pipelining: this needs no shares). Real ciphertexts sort first by ct_hash
/// so their positions are a pure function of the real ct_hash set (invariant
/// 6); decoys fill the tail.
async fn freeze_condition(app: &App, condition_id: &str, committee_id: &str) -> Result<()> {
    let committee = app
        .committee(committee_id)
        .context("unknown committee for frozen condition")?;
    let b = committee.b;

    // Sort real ciphertexts into position order.
    let mut real: Vec<(String, Vec<u8>)> = {
        let conn = app.0.db.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT ct_hash, sealed_blob FROM ciphertexts WHERE condition_id = ?1")?;
        let rows = stmt.query_map([condition_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    real.sort_by(|a, b| a.0.cmp(&b.0));

    // Decoys sealed by the coordinator itself fill the tail.
    let total = real.len() + committee.decoys_for(real.len());
    let mut rng = bte_crypto::os_rng();
    let mut dummies: Vec<(String, Vec<u8>)> = Vec::new();
    while real.len() + dummies.len() < total {
        let ct = committee.seal_decoy(condition_id, &mut rng);
        dummies.push((hex::encode(ct.hash()), ct.to_bytes()));
    }
    dummies.sort_by(|a, b| a.0.cmp(&b.0));
    let n_batches = total.div_ceil(b);
    if committee.scheme == scheme::Scheme::V1 && n_batches != 1 {
        // Intake caps a v1 condition at b - 1 real ciphertexts, so this is a
        // bug, not a load condition.
        anyhow::bail!("v1 condition {condition_id} exceeds one batch");
    }

    let ordered: Vec<(String, Vec<u8>)> = real.into_iter().chain(dummies.clone()).collect();

    let frozen_at = unix_now();
    let batch_ids: Vec<i64> = {
        let mut conn = app.0.db.lock().unwrap();
        let tx = conn.transaction()?;
        for (hash, blob) in &dummies {
            tx.execute(
                "INSERT INTO ciphertexts (ct_hash, condition_id, sealed_blob, is_dummy, created_at)
                 VALUES (?1, ?2, ?3, 1, ?4)",
                rusqlite::params![hash, condition_id, blob, frozen_at],
            )?;
        }
        for (pos, (hash, _)) in ordered.iter().enumerate() {
            tx.execute(
                "UPDATE ciphertexts SET position = ?1 WHERE ct_hash = ?2",
                rusqlite::params![pos as i64, hash],
            )?;
        }
        let mut ids = Vec::new();
        for batch_index in 0..n_batches {
            tx.execute(
                "INSERT INTO batches (condition_id, batch_index, frozen_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![condition_id, batch_index as i64, frozen_at],
            )?;
            ids.push(tx.last_insert_rowid());
        }
        tx.execute(
            "UPDATE conditions SET status = 'frozen' WHERE id = ?1",
            [condition_id],
        )?;

        // Ordering commitment, written INSIDE the freeze transaction.
        //
        // This is the load-bearing ordering in the whole design: the commitment
        // must exist before any operator can be handed work, or an executor
        // could read a batch and only then decide what order to claim. Writing
        // it in the same transaction means there is no window at all — a batch
        // is never frozen-but-uncommitted, even if the process dies here.
        for (batch_index, batch_id) in ids.iter().enumerate() {
            let slice = &ordered[batch_index * b..((batch_index + 1) * b).min(total)];
            let mut leaves = Vec::with_capacity(slice.len());
            for (pos_in_batch, (hash, _)) in slice.iter().enumerate() {
                let global_pos = batch_index * b + pos_in_batch;
                // An intent id when one is bound to this ciphertext, else empty.
                let intent_id: String = tx
                    .query_row(
                        "SELECT id FROM intents WHERE ciphertext_hash = ?1",
                        rusqlite::params![hash],
                        |r| r.get(0),
                    )
                    .optional()?
                    .unwrap_or_default();
                let raw = hex::decode(hash).unwrap_or_default();
                leaves.push(crate::merkle::ordering_leaf(&intent_id, &raw));
                let _ = global_pos;
            }
            let root = hex::encode(crate::merkle::root(&leaves));
            crate::intents::record_commitment(
                &tx,
                *batch_id,
                condition_id,
                &root,
                slice.len(),
                committee_id,
                &app.0.cfg.executor_identity,
            )?;
        }

        // Only now do the intents move: BATCHED, then ORDER_COMMITTED. The two
        // steps are separate events so a receipt's timeline shows ordering
        // locking as its own moment rather than being folded into the freeze.
        crate::intents::advance_condition_intents(&tx, condition_id, "VALIDATED")?;
        crate::intents::advance_condition_intents(&tx, condition_id, "BATCHED")?;
        crate::intents::advance_condition_intents(&tx, condition_id, "ORDER_COMMITTED")?;

        tx.commit()?;
        ids
    };
    info!(
        condition_id,
        batches = batch_ids.len(),
        total,
        "condition frozen"
    );

    // Pipelining: cross-terms depend only on ciphertexts + params, so they are
    // computed now, before any share exists.
    for (batch_index, batch_id) in batch_ids.iter().enumerate() {
        let cts: Vec<Sealed> = ordered[batch_index * b..((batch_index + 1) * b).min(total)]
            .iter()
            .map(|(_, blob)| Sealed::parse(blob).expect("stored blob is valid"))
            .collect();
        run_pre_decrypt(app, *batch_id, committee_id, cts).await?;
    }
    Ok(())
}

async fn run_pre_decrypt(
    app: &App,
    batch_id: i64,
    committee_id: &str,
    cts: Vec<Sealed>,
) -> Result<()> {
    let committee = app.committee(committee_id).context("unknown committee")?;
    let started = now_ms();
    let pre = tokio::task::spawn_blocking(move || scheme::pre_decrypt(&committee, &cts))
        .await
        .context("pre_decrypt task panicked")??;
    let elapsed = now_ms() - started;
    app.0.cross.lock().unwrap().insert(batch_id, Arc::new(pre));
    {
        let conn = app.0.db.lock().unwrap();
        conn.execute(
            "UPDATE batches SET predecrypt_ms = ?1 WHERE id = ?2",
            rusqlite::params![elapsed, batch_id],
        )?;
    }
    info!(
        batch_id,
        elapsed_ms = elapsed,
        "pre_decrypt complete (pipelined)"
    );
    Ok(())
}

/// (ct_hash, is_dummy, sealed_blob) rows in position order.
type CtRows = Vec<(String, bool, Vec<u8>)>;

/// Load a batch's ciphertexts in position order.
fn batch_cts(app: &App, batch_id: i64) -> Result<(String, String, usize, CtRows)> {
    let conn = app.0.db.lock().unwrap();
    let (condition_id, batch_index): (String, i64) = conn.query_row(
        "SELECT condition_id, batch_index FROM batches WHERE id = ?1",
        [batch_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let committee_id: String = conn.query_row(
        "SELECT committee_id FROM conditions WHERE id = ?1",
        [&condition_id],
        |r| r.get(0),
    )?;
    let b: usize = conn.query_row(
        "SELECT b FROM committees WHERE id = ?1",
        [&committee_id],
        |r| r.get::<_, i64>(0).map(|v| v as usize),
    )?;
    let lo = batch_index * b as i64;
    let hi = lo + b as i64;
    let mut stmt = conn.prepare(
        "SELECT ct_hash, is_dummy, sealed_blob FROM ciphertexts
         WHERE condition_id = ?1 AND position >= ?2 AND position < ?3
         ORDER BY position ASC",
    )?;
    let rows = stmt.query_map(rusqlite::params![condition_id, lo, hi], |r| {
        Ok((r.get(0)?, r.get::<_, i64>(1)? != 0, r.get(2)?))
    })?;
    let cts = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok((condition_id, committee_id, b, cts))
}

/// Finalize every frozen batch that has reached t verified shares, then mark
/// conditions revealed once all their batches are finalized.
async fn finalize_ready(app: &App) -> Result<()> {
    let ready: Vec<i64> = {
        let conn = app.0.db.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT b.id FROM batches b
             JOIN conditions c ON c.id = b.condition_id
             JOIN committees k ON k.id = c.committee_id
             WHERE b.finalized_at IS NULL
               AND (SELECT COUNT(*) FROM shares s
                    WHERE s.batch_id = b.id AND s.verified = 1) >= k.t",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<std::result::Result<_, _>>()?
    };

    for batch_id in ready {
        if let Err(e) = finalize_batch(app, batch_id).await {
            warn!(batch_id, error = %e, "finalize failed");
        }
    }

    // A condition is revealed when every one of its batches is finalized.
    let done: Vec<String> = {
        let conn = app.0.db.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT c.id FROM conditions c
             WHERE c.status IN ('frozen', 'stalled')
               AND NOT EXISTS (SELECT 1 FROM batches b
                               WHERE b.condition_id = c.id AND b.finalized_at IS NULL)
               AND EXISTS (SELECT 1 FROM batches b WHERE b.condition_id = c.id)",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    for condition_id in done {
        if let Err(e) = build_reveal(app, &condition_id) {
            warn!(condition_id, error = %e, "reveal build failed");
        }
    }
    Ok(())
}

async fn finalize_batch(app: &App, batch_id: i64) -> Result<()> {
    let (_, committee_id, _, ct_rows) = batch_cts(app, batch_id)?;
    let committee = app.committee(&committee_id).context("unknown committee")?;
    let cts: Vec<Sealed> = ct_rows
        .iter()
        .map(|(_, _, blob)| Sealed::parse(blob).expect("stored blob is valid"))
        .collect();

    // Cross-terms: cached from freeze time, or recomputed after a restart.
    let pre: Arc<CrossTerms> = {
        let cached = app.0.cross.lock().unwrap().get(&batch_id).cloned();
        match cached {
            Some(p) => p,
            None => {
                warn!(batch_id, "cross-terms missing (restart?) — recomputing");
                run_pre_decrypt(app, batch_id, &committee_id, cts.clone()).await?;
                app.0
                    .cross
                    .lock()
                    .unwrap()
                    .get(&batch_id)
                    .cloned()
                    .context("cross-terms absent after recompute")?
            }
        }
    };

    let shares: Vec<AnyShare> = {
        let conn = app.0.db.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT share_blob FROM shares
             WHERE batch_id = ?1 AND verified = 1
             ORDER BY submitted_at ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![batch_id, committee.t], |r| {
            r.get::<_, Vec<u8>>(0)
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
            .iter()
            .map(|blob| AnyShare::parse(blob).expect("stored share is valid"))
            .collect()
    };

    let started = now_ms();
    let pre2 = pre.clone();
    let cts2 = cts.clone();
    let recovered =
        tokio::task::spawn_blocking(move || scheme::finalize(&committee, &pre2, &shares, &cts2))
            .await
            .context("finalize task panicked")??;
    let elapsed = now_ms() - started;

    // Persist per-slot results onto the batch (joined into the reveal later).
    let slots: Vec<RevealSlot> = ct_rows
        .iter()
        .zip(&recovered)
        .map(|((hash, is_dummy, _), slot)| RevealSlot {
            position: 0, // filled from db position in build_reveal
            ct_hash: hash.clone(),
            is_dummy: *is_dummy,
            valid: slot.valid,
            payload_b64: {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.encode(&slot.payload)
            },
        })
        .collect();
    let slots_json = serde_json::to_string(&slots)?;
    {
        let conn = app.0.db.lock().unwrap();
        conn.execute(
            "UPDATE batches SET finalized_at = ?1, finalize_ms = ?2 WHERE id = ?3",
            rusqlite::params![unix_now(), elapsed, batch_id],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO batch_slots (batch_id, slots_json) VALUES (?1, ?2)",
            rusqlite::params![batch_id, slots_json],
        )?;
    }
    app.0.cross.lock().unwrap().remove(&batch_id);
    info!(batch_id, elapsed_ms = elapsed, "batch finalized");
    Ok(())
}

/// Assemble the condition-level reveal: all batch slots in position order,
/// merkle root over (position, payload), status -> revealed.
fn build_reveal(app: &App, condition_id: &str) -> Result<()> {
    use base64::Engine;
    let conn = app.0.db.lock().unwrap();

    let mut stmt = conn.prepare(
        "SELECT bs.slots_json FROM batches b
         JOIN batch_slots bs ON bs.batch_id = b.id
         WHERE b.condition_id = ?1 ORDER BY b.batch_index ASC",
    )?;
    let batch_jsons: Vec<String> = stmt
        .query_map([condition_id], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;

    let mut slots: Vec<RevealSlot> = Vec::new();
    for json in &batch_jsons {
        slots.extend(serde_json::from_str::<Vec<RevealSlot>>(json)?);
    }
    // Positions are global and stored on the ciphertext rows.
    for slot in &mut slots {
        slot.position = conn.query_row(
            "SELECT position FROM ciphertexts WHERE ct_hash = ?1",
            [&slot.ct_hash],
            |r| r.get::<_, i64>(0).map(|v| v as u32),
        )?;
    }
    slots.sort_by_key(|s| s.position);

    let leaves: Vec<[u8; 32]> = slots
        .iter()
        .map(|s| {
            let payload = base64::engine::general_purpose::STANDARD
                .decode(&s.payload_b64)
                .expect("we encoded this");
            merkle::leaf(s.position, &payload)
        })
        .collect();
    let root = merkle::root(&leaves);

    conn.execute(
        "INSERT OR REPLACE INTO reveals (condition_id, revealed_at, payloads_blob, merkle_root)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![
            condition_id,
            unix_now(),
            serde_json::to_string(&slots)?,
            hex::encode(root)
        ],
    )?;
    conn.execute(
        "UPDATE conditions SET status = 'revealed' WHERE id = ?1",
        [condition_id],
    )?;
    info!(
        condition_id,
        merkle_root = hex::encode(root),
        "condition revealed"
    );
    Ok(())
}

/// Liveness: frozen past REVEAL_TIMEOUT_SECS without a reveal -> stalled.
/// Stalled conditions still finalize if late shares arrive.
fn mark_stalled(app: &App) -> Result<()> {
    let cutoff = unix_now() - app.0.cfg.reveal_timeout_secs;
    let conn = app.0.db.lock().unwrap();
    let stalled = conn.execute(
        "UPDATE conditions SET status = 'stalled'
         WHERE status = 'frozen'
           AND EXISTS (SELECT 1 FROM batches b
                       WHERE b.condition_id = conditions.id
                         AND b.finalized_at IS NULL AND b.frozen_at <= ?1)",
        [cutoff],
    )?;
    if stalled > 0 {
        warn!(count = stalled, "conditions stalled waiting for shares");
    }
    Ok(())
}
