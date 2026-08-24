//! In-process integration tests: full seal -> freeze -> shares -> reveal flow
//! plus invariants 4 (no plaintext pre-reveal), 5 (padding), 6 (deterministic
//! positions).

use base64::Engine;
use bte_coordinator::{api, db, engine, state};
use bte_crypto::rand::SeedableRng;
use bte_crypto::wire::header_from_bytes;
use bte_crypto::{ceremony, partial, seal, CtHeader, OperatorSecret, PublicParams};
use rand_chacha::ChaCha20Rng;
use serde_json::{json, Value};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

struct Harness {
    app: state::App,
    base: String,
    client: reqwest::Client,
    params: PublicParams,
    secrets: Vec<OperatorSecret>,
    committee_id: String,
}

async fn harness() -> Harness {
    harness_seeded(7).await
}

/// Coordinator with an in-memory db and a registered n=3 t=2 B=4 committee.
/// The engine loop is NOT spawned; tests call engine::tick explicitly.
async fn harness_seeded(seed: u64) -> Harness {
    let mut rng = ChaCha20Rng::seed_from_u64(seed);
    let (params, secrets) = ceremony(3, 2, 4, &mut rng).unwrap();

    let conn = db::open(":memory:").unwrap();
    let app = state::App::new(conn, state::Config::from_env()).unwrap();
    let committee_id = app.register_committee(&params.to_bytes()).unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = api::router(app.clone());
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });

    Harness {
        app,
        base,
        client: reqwest::Client::new(),
        params,
        secrets,
        committee_id,
    }
}

impl Harness {
    async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        let resp = self
            .client
            .post(format!("{}{path}", self.base))
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(Value::Null))
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let resp = self
            .client
            .get(format!("{}{path}", self.base))
            .send()
            .await
            .unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(Value::Null))
    }

    /// Create a condition that is already due, seal payloads to it, and
    /// return (condition_id, sealed hashes).
    async fn seal_condition(&self, payloads: &[&[u8]]) -> (String, Vec<String>) {
        let (status, cond) = self
            .post(
                "/v0/conditions",
                json!({"committee_id": self.committee_id, "in_secs": 0}),
            )
            .await;
        assert_eq!(status, 200, "{cond}");
        let condition_id = cond["id"].as_str().unwrap().to_string();

        let mut rng = bte_crypto::os_rng();
        let mut hashes = Vec::new();
        for payload in payloads {
            let ct = seal(&self.params, payload, &mut rng).unwrap();
            let (status, resp) = self
                .post(
                    "/v0/ciphertexts",
                    json!({
                        "condition_id": condition_id,
                        "sealed_blob_b64": B64.encode(ct.to_bytes()),
                    }),
                )
                .await;
            assert_eq!(status, 200, "{resp}");
            hashes.push(resp["ct_hash"].as_str().unwrap().to_string());
        }
        (condition_id, hashes)
    }

    /// Fetch work for an operator and post its (honest) share everywhere.
    async fn work_and_share(&self, operator: &OperatorSecret) -> usize {
        let (status, work) = self
            .get(&format!("/v0/work?operator={}", operator.party_index))
            .await;
        assert_eq!(status, 200);
        let batches = work["batches"].as_array().unwrap();
        for batch in batches {
            let headers_raw = B64.decode(batch["headers_b64"].as_str().unwrap()).unwrap();
            let headers: Vec<CtHeader> = headers_raw
                .chunks(48)
                .map(|c| header_from_bytes(c).unwrap())
                .collect();
            let share = partial(operator, &headers).unwrap();
            let (status, resp) = self
                .post(
                    "/v0/shares",
                    json!({
                        "batch_id": batch["batch_id"],
                        "operator_id": operator.party_index,
                        "share_b64": B64.encode(share.to_bytes()),
                    }),
                )
                .await;
            assert_eq!(status, 200, "{resp}");
            assert_eq!(resp["verified"], json!(true), "{resp}");
        }
        batches.len()
    }
}

#[tokio::test]
async fn full_flow_seal_freeze_shares_reveal() {
    let h = harness().await;
    let (condition_id, _) = h
        .seal_condition(&[b"bid: alice 100", b"bid: bob 250"])
        .await;

    // Invariant 4: nothing readable before reveal.
    let (status, _) = h.get(&format!("/v0/reveals/{condition_id}")).await;
    assert_eq!(status, 404);

    // Tick fires + freezes + runs pre_decrypt (pipelined, before any share).
    engine::tick(&h.app).await.unwrap();
    let (_, cond) = h.get(&format!("/v0/conditions/{condition_id}")).await;
    assert_eq!(cond["status"], "frozen", "{cond}");
    let batch = &cond["batches"][0];
    assert!(
        batch["predecrypt_ms"].is_i64(),
        "pre_decrypt must complete at freeze time, before any share exists: {cond}"
    );

    // Sealing is closed after freeze.
    let mut rng = bte_crypto::os_rng();
    let late = seal(&h.params, b"too late", &mut rng).unwrap();
    let (status, resp) = h
        .post(
            "/v0/ciphertexts",
            json!({"condition_id": condition_id, "sealed_blob_b64": B64.encode(late.to_bytes())}),
        )
        .await;
    assert_eq!(status, 400, "{resp}");

    // t = 2 operators do their one-share-per-batch duty.
    assert_eq!(h.work_and_share(&h.secrets[0]).await, 1);
    assert_eq!(h.work_and_share(&h.secrets[2]).await, 1);

    engine::tick(&h.app).await.unwrap();
    let (status, reveal) = h.get(&format!("/v0/reveals/{condition_id}")).await;
    assert_eq!(status, 200, "{reveal}");

    let slots = reveal["slots"].as_array().unwrap();
    assert_eq!(slots.len(), 4, "padded to B");
    let real: Vec<&Value> = slots
        .iter()
        .filter(|s| s["is_dummy"] == json!(false))
        .collect();
    assert_eq!(real.len(), 2);
    let payloads: Vec<Vec<u8>> = real
        .iter()
        .map(|s| B64.decode(s["payload_b64"].as_str().unwrap()).unwrap())
        .collect();
    assert!(payloads.contains(&b"bid: alice 100".to_vec()));
    assert!(payloads.contains(&b"bid: bob 250".to_vec()));
    for slot in slots {
        assert_eq!(slot["valid"], json!(true));
    }
    assert_eq!(reveal["shares"].as_array().unwrap().len(), 2);
    assert!(reveal["merkle_root"].as_str().unwrap().len() == 64);
    let (_, cond) = h.get(&format!("/v0/conditions/{condition_id}")).await;
    assert_eq!(cond["status"], "revealed");
}

#[tokio::test]
async fn invariant_4_no_plaintext_before_reveal() {
    let h = harness().await;
    let secret = b"the secret nobody can read early";
    let (condition_id, _) = h.seal_condition(&[secret]).await;
    engine::tick(&h.app).await.unwrap();

    // Reveal endpoint 404s while pending shares.
    let (status, _) = h.get(&format!("/v0/reveals/{condition_id}")).await;
    assert_eq!(status, 404);

    // The plaintext must not exist anywhere in the database.
    {
        let conn = h.app.0.db.lock().unwrap();
        let reveal_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM reveals", [], |r| r.get(0))
            .unwrap();
        assert_eq!(reveal_count, 0);
        let mut stmt = conn.prepare("SELECT sealed_blob FROM ciphertexts").unwrap();
        let blobs: Vec<Vec<u8>> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for blob in blobs {
            assert!(
                !blob.windows(secret.len()).any(|w| w == secret.as_slice()),
                "plaintext bytes leaked into a stored blob"
            );
        }
    }
}

#[tokio::test]
async fn invariant_5_padding_with_dummies_marked() {
    let h = harness().await;
    let (condition_id, _) = h.seal_condition(&[b"only real payload"]).await;
    engine::tick(&h.app).await.unwrap();
    h.work_and_share(&h.secrets[0]).await;
    h.work_and_share(&h.secrets[1]).await;
    engine::tick(&h.app).await.unwrap();

    let (status, reveal) = h.get(&format!("/v0/reveals/{condition_id}")).await;
    assert_eq!(status, 200);
    let slots = reveal["slots"].as_array().unwrap();
    assert_eq!(slots.len(), 4, "1 real ct pads to B=4");
    let real: Vec<&Value> = slots
        .iter()
        .filter(|s| s["is_dummy"] == json!(false))
        .collect();
    assert_eq!(real.len(), 1, "exactly one real payload revealed");
    assert_eq!(
        B64.decode(real[0]["payload_b64"].as_str().unwrap())
            .unwrap(),
        b"only real payload"
    );
    let dummies: Vec<&Value> = slots
        .iter()
        .filter(|s| s["is_dummy"] == json!(true))
        .collect();
    assert_eq!(dummies.len(), 3, "dummies marked");
    for d in dummies {
        let payload = B64.decode(d["payload_b64"].as_str().unwrap()).unwrap();
        assert!(bte_crypto::is_dummy_payload(&payload));
    }
}

#[tokio::test]
async fn invariant_6_positions_pure_function_of_ct_hashes() {
    // Two coordinators, same sealed ciphertexts -> identical positions for
    // the real ciphertexts, independent of dummy randomness.
    let mut rng = ChaCha20Rng::seed_from_u64(99);
    let (params, _) = ceremony(3, 2, 4, &mut rng).unwrap();
    let cts: Vec<Vec<u8>> = (0..2)
        .map(|i| {
            seal(&params, format!("payload {i}").as_bytes(), &mut rng)
                .unwrap()
                .to_bytes()
        })
        .collect();

    let mut runs: Vec<Vec<(String, i64)>> = Vec::new();
    for _ in 0..2 {
        let conn = db::open(":memory:").unwrap();
        let app = state::App::new(conn, state::Config::from_env()).unwrap();
        let committee_id = app.register_committee(&params.to_bytes()).unwrap();
        {
            let c = app.0.db.lock().unwrap();
            c.execute(
                "INSERT INTO conditions (id, committee_id, kind, fires_at, status, created_at)
                 VALUES ('cond_x', ?1, 'at_time', 0, 'pending', 0)",
                [&committee_id],
            )
            .unwrap();
            for blob in &cts {
                let ct = bte_crypto::SealedCiphertext::from_bytes(blob).unwrap();
                c.execute(
                    "INSERT INTO ciphertexts (ct_hash, condition_id, sealed_blob, is_dummy, created_at)
                     VALUES (?1, 'cond_x', ?2, 0, 0)",
                    rusqlite::params![hex::encode(ct.hash()), blob],
                )
                .unwrap();
            }
        }
        engine::tick(&app).await.unwrap();
        let positions: Vec<(String, i64)> = {
            let c = app.0.db.lock().unwrap();
            let mut stmt = c
                .prepare(
                    "SELECT ct_hash, position FROM ciphertexts
                     WHERE is_dummy = 0 ORDER BY ct_hash",
                )
                .unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        runs.push(positions);
    }
    assert_eq!(
        runs[0], runs[1],
        "positions must be a pure function of the ct_hash set"
    );
}

#[tokio::test]
async fn rejected_share_flagged_never_used_and_stall_recovery() {
    let h = harness().await;
    let (condition_id, _) = h.seal_condition(&[b"resilient payload"]).await;
    engine::tick(&h.app).await.unwrap();

    // Operator 2 goes byzantine: submits operator 3's share under its own id
    // — wire-valid, cryptographically wrong.
    let (_, work) = h.get("/v0/work?operator=2").await;
    let batch = &work["batches"][0];
    let headers_raw = B64.decode(batch["headers_b64"].as_str().unwrap()).unwrap();
    let headers: Vec<CtHeader> = headers_raw
        .chunks(48)
        .map(|c| header_from_bytes(c).unwrap())
        .collect();
    let mut forged = partial(&h.secrets[2], &headers).unwrap();
    forged.party_index = 2;
    let (status, resp) = h
        .post(
            "/v0/shares",
            json!({
                "batch_id": batch["batch_id"],
                "operator_id": 2,
                "share_b64": B64.encode(forged.to_bytes()),
            }),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        resp["verified"],
        json!(false),
        "forged share must be rejected: {resp}"
    );

    // One honest share is not enough (t=2): the condition must not reveal.
    h.work_and_share(&h.secrets[0]).await;
    engine::tick(&h.app).await.unwrap();
    let (status, _) = h.get(&format!("/v0/reveals/{condition_id}")).await;
    assert_eq!(status, 404, "rejected share must never count toward t");

    // Force the stall path (timeout 0 via direct db poke on frozen_at).
    {
        let conn = h.app.0.db.lock().unwrap();
        conn.execute("UPDATE batches SET frozen_at = frozen_at - 100000", [])
            .unwrap();
    }
    engine::tick(&h.app).await.unwrap();
    let (_, cond) = h.get(&format!("/v0/conditions/{condition_id}")).await;
    assert_eq!(
        cond["status"], "stalled",
        "stall must be exposed, never a silent hang"
    );

    // A late honest share (operator 3 — operator 2 burned its slot on the
    // forged share) still recovers the batch.
    h.work_and_share(&h.secrets[2]).await;
    engine::tick(&h.app).await.unwrap();
    let (status, reveal) = h.get(&format!("/v0/reveals/{condition_id}")).await;
    assert_eq!(status, 200);
    // The rejected share appears in the log, flagged.
    let shares = reveal["shares"].as_array().unwrap();
    let rejected: Vec<&Value> = shares
        .iter()
        .filter(|s| s["verified"] == json!(false))
        .collect();
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0]["operator_id"], json!(2));
}

/// Short share codes: minted with the ciphertext, resolve back to the same
/// seal, stable across a replayed submit, and unguessable-shaped.
#[tokio::test]
async fn share_code_minted_and_resolves() {
    let h = harness().await;
    let (status, cond) = h
        .post(
            "/v0/conditions",
            json!({"committee_id": h.committee_id, "in_secs": 60}),
        )
        .await;
    assert_eq!(status, 200, "{cond}");
    let condition_id = cond["id"].as_str().unwrap().to_string();

    let mut rng = bte_crypto::os_rng();
    let ct = seal(&h.params, b"hello", &mut rng).unwrap();
    let blob = B64.encode(ct.to_bytes());
    let (status, resp) = h
        .post(
            "/v0/ciphertexts",
            json!({"condition_id": condition_id, "sealed_blob_b64": blob}),
        )
        .await;
    assert_eq!(status, 200, "{resp}");
    let ct_hash = resp["ct_hash"].as_str().unwrap().to_string();
    let code = resp["code"].as_str().expect("submit returns a share code");

    // 8 random bytes as base64url, no padding.
    assert_eq!(code.len(), 11, "code is 11 chars, got {code}");
    assert!(
        code.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "code is base64url: {code}"
    );

    // Resolves to exactly the seal it was minted for.
    let (status, got) = h.get(&format!("/v0/seals/{code}")).await;
    assert_eq!(status, 200, "{got}");
    assert_eq!(got["ct_hash"].as_str().unwrap(), ct_hash);
    assert_eq!(got["condition_id"].as_str().unwrap(), condition_id);

    // A replayed submit is idempotent: same ct_hash, SAME code, not a fresh
    // one (INSERT OR IGNORE keeps the original row).
    let (status, again) = h
        .post(
            "/v0/ciphertexts",
            json!({"condition_id": condition_id, "sealed_blob_b64": blob}),
        )
        .await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["ct_hash"].as_str().unwrap(), ct_hash);
    assert_eq!(again["code"].as_str().unwrap(), code, "code must be stable");

    // Unknown and malformed codes do not leak a difference in kind.
    let (status, _) = h.get("/v0/seals/AAAAAAAAAAA").await;
    assert_eq!(status, 404);
    let (status, _) = h.get("/v0/seals/not%20a%20code").await;
    assert_eq!(status, 400);

    // Two seals never share a code.
    let ct2 = seal(&h.params, b"world", &mut rng).unwrap();
    let (_, resp2) = h
        .post(
            "/v0/ciphertexts",
            json!({"condition_id": condition_id, "sealed_blob_b64": B64.encode(ct2.to_bytes())}),
        )
        .await;
    assert_ne!(resp2["code"].as_str().unwrap(), code);
}

/// A database written before share codes existed keeps working: the migration
/// is additive, pre-existing rows survive, and their long-form share links
/// still resolve without a code.
#[tokio::test]
async fn share_code_migration_preserves_existing_rows() {
    // A db as it looked before the code column: open(), then drop the column
    // back out to simulate the old shape.
    let conn = db::open(":memory:").unwrap();
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_cts_code;
         ALTER TABLE ciphertexts DROP COLUMN code;",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO committees (id, params_blob, params_digest, n, t, b, created_at)
         VALUES ('c', x'00', 'c', 3, 2, 4, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO conditions (id, committee_id, kind, fires_at, status, created_at)
         VALUES ('cond_legacy', 'c', 'at_time', 0, 'pending', 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO ciphertexts (ct_hash, condition_id, sealed_blob, is_dummy, created_at)
         VALUES ('deadbeef', 'cond_legacy', x'00', 0, 0)",
        [],
    )
    .unwrap();

    // Re-running the migration on that db must not drop or alter the row.
    conn.execute("ALTER TABLE ciphertexts ADD COLUMN code TEXT", [])
        .ok();
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_cts_code ON ciphertexts(code) WHERE code IS NOT NULL;",
    )
    .unwrap();

    let (ct_hash, condition_id, code): (String, String, Option<String>) = conn
        .query_row(
            "SELECT ct_hash, condition_id, code FROM ciphertexts WHERE ct_hash = 'deadbeef'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(ct_hash, "deadbeef");
    assert_eq!(condition_id, "cond_legacy");
    assert_eq!(
        code, None,
        "legacy rows keep a NULL code, nothing backfilled"
    );

    // The partial index tolerates many NULL codes (a full UNIQUE index would
    // not, and every legacy row has one).
    conn.execute(
        "INSERT INTO ciphertexts (ct_hash, condition_id, sealed_blob, is_dummy, created_at)
         VALUES ('cafebabe', 'cond_legacy', x'00', 0, 0)",
        [],
    )
    .expect("a second NULL-code row must be allowed");
}

/// THE COMPATIBILITY GUARANTEE: seals created before short share codes existed
/// keep working end to end after the upgrade.
///
/// Builds a database in the pre-code shape, seals into it exactly as the old
/// binary would (no code column at all), then runs the new migration over that
/// live data and drives the pre-existing seal all the way to reveal. This is
/// what a link already sitting in someone's DMs depends on.
#[tokio::test]
async fn seals_predating_share_codes_still_reveal_after_upgrade() {
    let mut rng = ChaCha20Rng::seed_from_u64(11);
    let (params, secrets) = ceremony(3, 2, 4, &mut rng).unwrap();

    // --- old world: a db with no `code` column, holding a real pending seal.
    let conn = db::open(":memory:").unwrap();
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_cts_code;
         ALTER TABLE ciphertexts DROP COLUMN code;",
    )
    .unwrap();
    let app = state::App::new(conn, state::Config::from_env()).unwrap();
    let committee_id = app.register_committee(&params.to_bytes()).unwrap();

    let condition_id = "cond_beforecodes".to_string();
    let mut os = bte_crypto::os_rng();
    let ct = seal(&params, b"sealed before the upgrade", &mut os).unwrap();
    let ct_hash = hex::encode(ct.hash());
    {
        let conn = app.0.db.lock().unwrap();
        conn.execute(
            "INSERT INTO conditions (id, committee_id, kind, fires_at, status, created_at)
             VALUES (?1, ?2, 'at_time', 0, 'pending', 0)",
            rusqlite::params![condition_id, committee_id],
        )
        .unwrap();
        // Note the column list: exactly what the old binary wrote.
        conn.execute(
            "INSERT INTO ciphertexts (ct_hash, condition_id, sealed_blob, is_dummy, created_at)
             VALUES (?1, ?2, ?3, 0, 0)",
            rusqlite::params![ct_hash, condition_id, ct.to_bytes()],
        )
        .unwrap();
    }

    // --- the upgrade: exactly the migration db::open() now runs on boot.
    {
        let conn = app.0.db.lock().unwrap();
        conn.execute("ALTER TABLE ciphertexts ADD COLUMN code TEXT", [])
            .ok();
        conn.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_cts_code ON ciphertexts(code) WHERE code IS NOT NULL;",
        )
        .unwrap();
    }

    // --- new world: the pre-existing seal is untouched and still addressable
    // by exactly what its long-form link carries: condition id + full ct_hash.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = api::router(app.clone());
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let client = reqwest::Client::new();
    let get = |path: String| {
        let client = client.clone();
        let base = base.clone();
        async move {
            let resp = client.get(format!("{base}{path}")).send().await.unwrap();
            let status = resp.status().as_u16();
            (status, resp.json::<Value>().await.unwrap_or(Value::Null))
        }
    };

    let (status, cond) = get(format!("/v0/conditions/{condition_id}")).await;
    assert_eq!(status, 200, "old condition must still be readable: {cond}");
    assert_eq!(
        cond["real_count"],
        json!(1),
        "the old seal is still counted"
    );

    // Drive it to reveal, the same path the old link's page polls.
    engine::tick(&app).await.unwrap();
    for s in &secrets {
        let (status, work) = get(format!("/v0/work?operator={}", s.party_index)).await;
        assert_eq!(status, 200);
        for batch in work["batches"].as_array().unwrap() {
            let raw = B64.decode(batch["headers_b64"].as_str().unwrap()).unwrap();
            let headers: Vec<CtHeader> = raw
                .chunks(48)
                .map(|c| header_from_bytes(c).unwrap())
                .collect();
            let share = partial(s, &headers).unwrap();
            let resp = client
                .post(format!("{base}/v0/shares"))
                .json(&json!({
                    "batch_id": batch["batch_id"],
                    "operator_id": s.party_index,
                    "share_b64": B64.encode(share.to_bytes()),
                }))
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status().as_u16(), 200);
        }
    }
    engine::tick(&app).await.unwrap();

    // The exact lookup the old share-link page performs: find my slot by the
    // full ct_hash the link carried, and read the payload back.
    let (status, reveal) = get(format!("/v0/reveals/{condition_id}")).await;
    assert_eq!(status, 200, "{reveal}");
    let slot = reveal["slots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["ct_hash"].as_str() == Some(ct_hash.as_str()))
        .expect("the pre-upgrade seal must still be findable by its ct_hash");
    let payload = B64.decode(slot["payload_b64"].as_str().unwrap()).unwrap();
    assert_eq!(
        payload, b"sealed before the upgrade",
        "a link shared before the upgrade must still open its content"
    );
    assert_eq!(slot["valid"], json!(true));

    // And it never acquired a share code: nothing backfilled, nothing rewritten.
    let conn = app.0.db.lock().unwrap();
    let code: Option<String> = conn
        .query_row(
            "SELECT code FROM ciphertexts WHERE ct_hash = ?1",
            [&ct_hash],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        code, None,
        "pre-existing rows are left exactly as they were"
    );
}

/// A document-sized payload survives the whole path byte for byte.
///
/// This is the file case: the 4 KiB cap was a policy number, not a
/// cryptographic one, so a PDF goes through the same seal, freeze, share and
/// reveal that text does. Also pins the two things that made raising the cap
/// affordable: operator work is over 48-byte headers regardless of payload
/// size, and dummy padding stays tiny.
#[tokio::test]
async fn document_sized_payload_round_trips() {
    let h = harness().await;

    // 400 KiB of non-repeating bytes, so a truncation or an off-by-one in the
    // keystream cannot pass by accident.
    let mut doc = b"%PDF-1.7\n".to_vec();
    let mut x: u32 = 0x12345678;
    while doc.len() < 400 * 1024 {
        x = x.wrapping_mul(1664525).wrapping_add(1013904223);
        doc.extend_from_slice(&x.to_le_bytes());
    }
    // An absolute floor, not a fraction of the cap: this test is about a real
    // document making the round trip, so raising the cap should not silently
    // drag the payload — and the test time — up with it. The cap boundary
    // itself is covered by `oversize_payload_is_still_rejected`.
    assert!(doc.len() >= 256 * 1024, "payload should be substantial");

    let (status, cond) = h
        .post(
            "/v0/conditions",
            json!({"committee_id": h.committee_id, "in_secs": 0}),
        )
        .await;
    assert_eq!(status, 200, "{cond}");
    let condition_id = cond["id"].as_str().unwrap().to_string();

    let mut rng = bte_crypto::os_rng();
    let ct = seal(&h.params, &doc, &mut rng).unwrap();
    let sealed_len = ct.to_bytes().len();
    let (status, resp) = h
        .post(
            "/v0/ciphertexts",
            json!({"condition_id": condition_id, "sealed_blob_b64": B64.encode(ct.to_bytes())}),
        )
        .await;
    assert_eq!(status, 200, "a 400 KiB seal must be accepted: {resp}");
    let ct_hash = resp["ct_hash"].as_str().unwrap().to_string();

    engine::tick(&h.app).await.unwrap();
    for s in &h.secrets {
        h.work_and_share(s).await;
    }
    engine::tick(&h.app).await.unwrap();

    let (status, reveal) = h.get(&format!("/v0/reveals/{condition_id}")).await;
    assert_eq!(status, 200, "{reveal}");
    let slot = reveal["slots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["ct_hash"].as_str() == Some(ct_hash.as_str()))
        .expect("our slot must be in the reveal");
    assert_eq!(slot["valid"], json!(true), "{slot}");
    let got = B64.decode(slot["payload_b64"].as_str().unwrap()).unwrap();
    assert_eq!(got.len(), doc.len(), "payload length changed");
    assert_eq!(got, doc, "payload came back altered");

    // The wire body is a keystream XOR, so the ciphertext tracks the payload
    // and nothing quadratic crept in with the bigger cap.
    assert!(
        sealed_len < doc.len() + 256,
        "sealed blob {sealed_len} is not payload-sized for a {} byte doc",
        doc.len()
    );

    // Padding stays cheap: dummies are a fixed ~29 bytes each, so one big real
    // seal does not multiply across the batch.
    let dummy_total: usize = reveal["slots"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["is_dummy"] == json!(true))
        .map(|s| {
            B64.decode(s["payload_b64"].as_str().unwrap())
                .unwrap()
                .len()
        })
        .sum();
    assert!(
        dummy_total < 4096,
        "63 dummies should cost under 4 KiB total, got {dummy_total}"
    );
}

/// The cap is still enforced; raising it did not remove the check.
#[tokio::test]
async fn oversize_payload_is_still_rejected() {
    let mut rng = bte_crypto::os_rng();
    let params = harness().await.params;
    let too_big = vec![0u8; bte_crypto::MAX_PAYLOAD_BYTES + 1];
    assert!(
        seal(&params, &too_big, &mut rng).is_err(),
        "a payload one byte over the cap must be refused"
    );
    let ok = vec![0u8; bte_crypto::MAX_PAYLOAD_BYTES];
    assert!(
        seal(&params, &ok, &mut rng).is_ok(),
        "exactly the cap must be accepted"
    );
}
