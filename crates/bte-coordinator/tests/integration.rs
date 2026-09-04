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

/// A cap-sized seal must survive the HTTP layer, not just `seal()`.
///
/// The router's body limit is derived from the payload cap, and getting that
/// derivation wrong fails in the worst way: every unit test stays green while
/// real uploads near the cap come back 413. This posts a seal at the cap
/// through the real router so the two numbers cannot drift apart.
#[tokio::test]
async fn a_cap_sized_seal_fits_through_the_body_limit() {
    let h = harness().await;
    let (status, cond) = h
        .post(
            "/v0/conditions",
            json!({"committee_id": h.committee_id, "in_secs": 0}),
        )
        .await;
    assert_eq!(status, 200, "{cond}");
    let condition_id = cond["id"].as_str().unwrap().to_string();

    let mut rng = bte_crypto::os_rng();
    let big = vec![0xa5u8; bte_crypto::MAX_PAYLOAD_BYTES];
    let ct = seal(&h.params, &big, &mut rng).unwrap();
    let (status, resp) = h
        .post(
            "/v0/ciphertexts",
            json!({"condition_id": condition_id, "sealed_blob_b64": B64.encode(ct.to_bytes())}),
        )
        .await;
    assert_eq!(
        status, 200,
        "a seal at exactly the cap must pass the body limit: {resp}"
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

#[tokio::test]
async fn listing_conditions_reports_how_many_exist_not_how_many_fit() {
    // The list is capped at 100. A client counting the array it received would
    // report 100 forever once the network passed that, which reads as nothing
    // happening at exactly the moment the most is.
    let h = harness().await;

    let body: Value = h
        .client
        .get(format!("{}/v0/conditions", h.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["total"].as_i64().unwrap(), 0);

    for _ in 0..3 {
        let (status, _) = h
            .post(
                "/v0/conditions",
                json!({"committee_id": h.committee_id, "in_secs": 600}),
            )
            .await;
        assert_eq!(status, 200);
    }

    let body: Value = h
        .client
        .get(format!("{}/v0/conditions", h.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["total"].as_i64().unwrap(), 3);
    assert_eq!(body["conditions"].as_array().unwrap().len(), 3);
}

/// The numbers behind the developer leaderboard.
///
/// It reports WORK, not people: there are no accounts here, so a tag is the
/// only attribution the network has. These assertions are about the two ways
/// that count could quietly lie.
#[tokio::test]
async fn stats_count_real_work_per_tag() {
    let h = harness().await;

    // Two apps and one caller who sent no tag at all.
    for (tag, payloads) in [
        (Some("alpha"), 3usize),
        (Some("alpha"), 1),
        (Some("beta"), 2),
        (None, 2),
    ] {
        let mut body = json!({"committee_id": h.committee_id, "in_secs": 600});
        if let Some(t) = tag {
            body["tag"] = json!(t);
        }
        let (status, cond) = h.post("/v0/conditions", body).await;
        assert_eq!(status, 200, "{cond}");
        let id = cond["id"].as_str().unwrap().to_string();

        let mut rng = bte_crypto::os_rng();
        for i in 0..payloads {
            let ct = seal(&h.params, format!("payload {i}").as_bytes(), &mut rng).unwrap();
            let (status, _) = h
                .post(
                    "/v0/ciphertexts",
                    json!({"condition_id": id, "sealed_blob_b64": B64.encode(ct.to_bytes())}),
                )
                .await;
            assert_eq!(status, 200);
        }
    }

    let (status, stats) = h.get("/v0/stats").await;
    assert_eq!(status, 200, "{stats}");

    // Totals cover everything, tagged or not.
    assert_eq!(stats["totals"]["conditions"], 4);
    assert_eq!(stats["totals"]["sealed"], 8);
    assert_eq!(stats["totals"]["pending"], 4);

    let tags = stats["tags"].as_array().unwrap();
    // The untagged condition is real work but nobody claimed it, so it is in
    // the totals and not on the board.
    assert_eq!(tags.len(), 2, "{stats}");

    // Ordered by how much is under each tag, which is what a board is for.
    assert_eq!(tags[0]["tag"], "alpha");
    assert_eq!(tags[0]["conditions"], 2);
    assert_eq!(tags[0]["ciphertexts"], 4);
    assert_eq!(tags[1]["tag"], "beta");
    assert_eq!(tags[1]["conditions"], 1);
    assert_eq!(tags[1]["ciphertexts"], 2);
}

/// The coordinator pads every batch to a multiple of B with its own dummies.
/// Counting those would mean a tag with one real bid reporting sixty four, and
/// the board would be showing our own work back to us as somebody else's.
#[tokio::test]
async fn stats_never_count_the_coordinator_s_own_padding() {
    let h = harness().await;

    let (status, cond) = h
        .post(
            "/v0/conditions",
            json!({"committee_id": h.committee_id, "in_secs": 0, "tag": "solo"}),
        )
        .await;
    assert_eq!(status, 200, "{cond}");
    let id = cond["id"].as_str().unwrap().to_string();

    let mut rng = bte_crypto::os_rng();
    let ct = seal(&h.params, b"the only real one", &mut rng).unwrap();
    h.post(
        "/v0/ciphertexts",
        json!({"condition_id": id, "sealed_blob_b64": B64.encode(ct.to_bytes())}),
    )
    .await;

    // Freeze, which is where the padding is written.
    engine::tick(&h.app).await.unwrap();

    let (_, stats) = h.get("/v0/stats").await;
    // B is 4 in this harness, so freezing added three dummies.
    assert_eq!(stats["totals"]["padding"], 3, "{stats}");
    assert_eq!(stats["totals"]["sealed"], 1);
    assert_eq!(stats["tags"][0]["tag"], "solo");
    assert_eq!(
        stats["tags"][0]["ciphertexts"], 1,
        "padding leaked in: {stats}"
    );
}

/// A window a caller asks for is clamped rather than trusted: this is an
/// unauthenticated endpoint doing a table scan.
#[tokio::test]
async fn stats_window_is_bounded() {
    let h = harness().await;
    for (asked, want) in [
        ("1", 60),
        ("0", 60),
        ("-99999", 60),
        ("999999999", 366 * 24 * 60 * 60),
    ] {
        let (status, stats) = h.get(&format!("/v0/stats?window_secs={asked}")).await;
        assert_eq!(status, 200);
        assert_eq!(stats["window_secs"], want, "asked for {asked}");
    }
}

// ---------------------------------------------------------------- v1 API ----

impl Harness {
    async fn get_full(&self, path: &str) -> (u16, Value, reqwest::header::HeaderMap) {
        let resp = self
            .client
            .get(format!("{}{path}", self.base))
            .send()
            .await
            .unwrap();
        let status = resp.status().as_u16();
        let headers = resp.headers().clone();
        (status, resp.json().await.unwrap_or(Value::Null), headers)
    }

    /// Wait for a round to fall due, then freeze, share and finalise it.
    ///
    /// The wait is real rather than skipped: v1 refuses to create a round that
    /// opens in the past, because nothing could be sealed to one, so a test
    /// cannot shortcut by backdating the deadline.
    async fn drive_to_reveal(&self, round_id: &str) {
        let (_, round) = self.get(&format!("/v1/rounds/{round_id}")).await;
        if let Some(at) = round["opens_at_unix"].as_i64() {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64;
            if at >= now {
                tokio::time::sleep(std::time::Duration::from_millis(
                    ((at - now) as u64 + 1) * 1000,
                ))
                .await;
            }
        }
        // Freeze: the round is due, so the engine pads and creates batches.
        engine::tick(&self.app).await.unwrap();
        for secret in &self.secrets {
            self.work_and_share(secret).await;
        }
        engine::tick(&self.app).await.unwrap();
        let (_, round) = self.get(&format!("/v1/rounds/{round_id}")).await;
        assert_eq!(round["status"], "opened", "round never opened: {round}");
    }

    async fn post_keyed(&self, path: &str, key: &str, body: Value) -> (u16, Value) {
        let resp = self
            .client
            .post(format!("{}{path}", self.base))
            .header("idempotency-key", key)
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(Value::Null))
    }
}
/// The lifecycle a caller actually follows, on one URL, with no 404 standing in
/// for a state.
#[tokio::test]
async fn v1_round_reports_every_stage_on_one_url() {
    let h = harness().await;

    let (status, round) = h
        .post("/v1/rounds", json!({"opens_in": 600, "tag": "shop"}))
        .await;
    assert_eq!(status, 201, "{round}");
    let id = round["id"].as_str().unwrap().to_string();
    assert_eq!(round["status"], "open");
    assert_eq!(round["tag"], "shop");
    assert_eq!(round["seals"], 0);
    // ISO for people, unix for arithmetic, and never a relative time on the way
    // out.
    assert!(
        round["opens_at"].as_str().unwrap().ends_with('Z'),
        "{round}"
    );
    assert!(round["opens_at_unix"].as_i64().unwrap() > 0);
    assert!(round.get("opens_in").is_none());

    let mut rng = bte_crypto::os_rng();
    let ct = seal(&h.params, b"a sealed bid", &mut rng).unwrap();
    let (status, sealed) = h
        .post(
            &format!("/v1/rounds/{id}/seals"),
            json!({"ciphertext_b64": B64.encode(ct.to_bytes())}),
        )
        .await;
    assert_eq!(status, 201, "{sealed}");
    // The id is the hash of the ciphertext, so the caller can compute it and
    // never has to trust our answer about which row is theirs.
    assert_eq!(sealed["id"], hex::encode(ct.hash()));

    let (status, open) = h.get(&format!("/v1/rounds/{id}")).await;
    assert_eq!(status, 200);
    assert_eq!(open["status"], "open");
    assert_eq!(open["seals"], 1);
    assert_eq!(open["opened_at"], Value::Null);

    // While open, seals list without payloads. There is nothing to leak: the
    // coordinator does not hold one.
    let (_, listed) = h.get(&format!("/v1/rounds/{id}/seals")).await;
    assert_eq!(listed["data"].as_array().unwrap().len(), 1);
    assert!(listed["data"][0].get("payload_b64").is_none(), "{listed}");
}
#[tokio::test]
async fn v1_round_opens_and_carries_the_payload() {
    let h = harness().await;
    let (_, round) = h.post("/v1/rounds", json!({"opens_in": 1})).await;
    let id = round["id"].as_str().unwrap().to_string();

    let mut rng = bte_crypto::os_rng();
    let ct = seal(&h.params, b"the payload", &mut rng).unwrap();
    h.post(
        &format!("/v1/rounds/{id}/seals"),
        json!({"ciphertext_b64": B64.encode(ct.to_bytes())}),
    )
    .await;
    let seal_id = hex::encode(ct.hash());

    h.drive_to_reveal(&id).await;

    let (status, round) = h.get(&format!("/v1/rounds/{id}")).await;
    assert_eq!(status, 200);
    assert_eq!(round["status"], "opened", "{round}");
    assert_ne!(round["opened_at"], Value::Null);
    // The count of real seals never includes the decoys, and the field that
    // does is named so nobody reads it as a participant count.
    assert_eq!(round["seals"], 1);
    assert!(round["slots_including_decoys"].as_i64().unwrap() > 1);

    let (_, one) = h.get(&format!("/v1/seals/{seal_id}")).await;
    assert_eq!(one["status"], "opened", "{one}");
    assert_eq!(
        B64.decode(one["payload_b64"].as_str().unwrap()).unwrap(),
        b"the payload"
    );
}
/// A retried create must not split one auction into two.
#[tokio::test]
async fn v1_idempotency_key_makes_create_retry_safe() {
    let h = harness().await;
    let body = json!({"opens_in": 600, "tag": "retry"});

    let (first_status, first) = h.post_keyed("/v1/rounds", "abc-123", body.clone()).await;
    let (second_status, second) = h.post_keyed("/v1/rounds", "abc-123", body.clone()).await;

    assert_eq!(first_status, 201);
    // 200, not 201: the second call created nothing.
    assert_eq!(second_status, 200);
    assert_eq!(first["id"], second["id"]);

    // A different key is a different intent, so it makes a second round.
    let (status, other) = h.post_keyed("/v1/rounds", "different", body).await;
    assert_eq!(status, 201);
    assert_ne!(other["id"], first["id"]);
}
/// The query v0 could not answer, which is what made tags decorative.
#[tokio::test]
async fn v1_rounds_filter_by_tag_and_page_without_gaps() {
    let h = harness().await;
    for i in 0..7 {
        h.post("/v1/rounds", json!({"opens_in": 600 + i, "tag": "mine"}))
            .await;
    }
    for i in 0..3 {
        h.post("/v1/rounds", json!({"opens_in": 600 + i, "tag": "theirs"}))
            .await;
    }

    let (status, page) = h.get("/v1/rounds?tag=mine&limit=3").await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(page["data"].as_array().unwrap().len(), 3);
    assert_eq!(page["has_more"], true);

    // Walk every page and prove the cursor is total: rows created inside the
    // same second must not be skipped or repeated.
    let mut seen: Vec<String> = Vec::new();
    let mut cursor = page["next_cursor"].as_str().map(str::to_owned);
    for row in page["data"].as_array().unwrap() {
        seen.push(row["id"].as_str().unwrap().to_string());
        assert_eq!(row["tag"], "mine");
    }
    while let Some(c) = cursor {
        let (_, next) = h
            .get(&format!("/v1/rounds?tag=mine&limit=3&cursor={c}"))
            .await;
        for row in next["data"].as_array().unwrap() {
            seen.push(row["id"].as_str().unwrap().to_string());
            assert_eq!(row["tag"], "mine");
        }
        cursor = next["next_cursor"].as_str().map(str::to_owned);
    }
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), 7, "cursor skipped or repeated rows");

    let (_, by_status) = h.get("/v1/rounds?status=open&tag=theirs").await;
    assert_eq!(by_status["data"].as_array().unwrap().len(), 3);
}
/// Errors a program can branch on, rather than English it has to match.
#[tokio::test]
async fn v1_errors_are_problem_json_with_a_stable_code() {
    let h = harness().await;

    let (status, body, headers) = {
        let resp = h
            .client
            .post(format!("{}/v1/rounds", h.base))
            .json(&json!({"tag": "no-deadline"}))
            .send()
            .await
            .unwrap();
        let s = resp.status().as_u16();
        let hd = resp.headers().clone();
        (s, resp.json::<Value>().await.unwrap(), hd)
    };
    assert_eq!(status, 400);
    assert_eq!(headers["content-type"], "application/problem+json");
    assert_eq!(body["code"], "missing_deadline");
    assert_eq!(body["field"], "opens_at");
    assert_eq!(body["status"], 400);
    assert!(body["type"].as_str().unwrap().starts_with("https://"));

    for (payload, code) in [
        (json!({"opens_in": 600, "tag": "BAD CAPS"}), "invalid_tag"),
        (json!({"opens_at": "not a date"}), "invalid_time"),
        (json!({"opens_in": -5}), "opens_in_past"),
    ] {
        let (_, body) = h.post("/v1/rounds", payload).await;
        assert_eq!(body["code"], code, "{body}");
    }

    let (status, body) = h.get("/v1/rounds/cond_nope").await;
    assert_eq!(status, 404);
    assert_eq!(body["code"], "not_found");

    let (_, body) = h.get("/v1/rounds?status=banana").await;
    assert_eq!(body["code"], "invalid_status");
    let (_, body) = h.get("/v1/rounds?cursor=!!!not-base64!!!").await;
    assert_eq!(body["code"], "invalid_cursor");
}
/// A closed round refuses new seals with a conflict, not a generic 400: the
/// request was well formed, the world moved.
#[tokio::test]
async fn v1_sealing_after_the_close_is_a_conflict() {
    let h = harness().await;
    let (_, round) = h.post("/v1/rounds", json!({"opens_in": 1})).await;
    let id = round["id"].as_str().unwrap().to_string();
    h.drive_to_reveal(&id).await;

    let mut rng = bte_crypto::os_rng();
    let ct = seal(&h.params, b"too late", &mut rng).unwrap();
    let (status, body) = h
        .post(
            &format!("/v1/rounds/{id}/seals"),
            json!({"ciphertext_b64": B64.encode(ct.to_bytes())}),
        )
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "round_closed");
}
/// Anything that is not a ciphertext is refused at the door. One unopenable
/// member would spoil the reveal for everybody else in the batch.
#[tokio::test]
async fn v1_refuses_anything_that_is_not_a_ciphertext() {
    let h = harness().await;
    let (_, round) = h.post("/v1/rounds", json!({"opens_in": 600})).await;
    let id = round["id"].as_str().unwrap();

    let (status, body) = h
        .post(
            &format!("/v1/rounds/{id}/seals"),
            json!({"ciphertext_b64": "!!!"}),
        )
        .await;
    assert_eq!(status, 400);
    assert_eq!(body["code"], "invalid_base64");

    let (status, body) = h
        .post(
            &format!("/v1/rounds/{id}/seals"),
            json!({"ciphertext_b64": B64.encode(b"not a ciphertext")}),
        )
        .await;
    assert_eq!(status, 422, "{body}");
    assert_eq!(body["code"], "invalid_ciphertext");
}
/// The same ciphertext is the same seal, so a retry needs no key.
#[tokio::test]
async fn v1_reposting_a_seal_is_the_same_seal() {
    let h = harness().await;
    let (_, round) = h.post("/v1/rounds", json!({"opens_in": 600})).await;
    let id = round["id"].as_str().unwrap();
    let mut rng = bte_crypto::os_rng();
    let ct = seal(&h.params, b"once", &mut rng).unwrap();
    let body = json!({"ciphertext_b64": B64.encode(ct.to_bytes())});

    let (first, a) = h
        .post(&format!("/v1/rounds/{id}/seals"), body.clone())
        .await;
    let (second, b) = h.post(&format!("/v1/rounds/{id}/seals"), body).await;
    assert_eq!(first, 201);
    assert_eq!(second, 200);
    assert_eq!(a["id"], b["id"]);

    let (_, round) = h.get(&format!("/v1/rounds/{id}")).await;
    assert_eq!(round["seals"], 1, "a retry created a second seal");
}
/// Polling a deadline should be nearly free.
#[tokio::test]
async fn v1_etag_lets_a_poller_wait_cheaply() {
    let h = harness().await;
    let (_, round) = h.post("/v1/rounds", json!({"opens_in": 600})).await;
    let id = round["id"].as_str().unwrap().to_string();

    let (status, _, headers) = h.get_full(&format!("/v1/rounds/{id}")).await;
    assert_eq!(status, 200);
    let tag = headers["etag"].to_str().unwrap().to_string();

    let unchanged = h
        .client
        .get(format!("{}/v1/rounds/{id}", h.base))
        .header("if-none-match", &tag)
        .send()
        .await
        .unwrap();
    assert_eq!(unchanged.status().as_u16(), 304);

    // Something actually happened, so the tag must move.
    let mut rng = bte_crypto::os_rng();
    let ct = seal(&h.params, b"changes things", &mut rng).unwrap();
    h.post(
        &format!("/v1/rounds/{id}/seals"),
        json!({"ciphertext_b64": B64.encode(ct.to_bytes())}),
    )
    .await;
    let changed = h
        .client
        .get(format!("{}/v1/rounds/{id}", h.base))
        .header("if-none-match", &tag)
        .send()
        .await
        .unwrap();
    assert_eq!(changed.status().as_u16(), 200);
}
/// Both time forms in, one form out.
#[tokio::test]
async fn v1_accepts_rfc3339_or_unix_and_answers_in_both() {
    let h = harness().await;
    let future = crate_unix_now() + 3600;

    let (_, a) = h.post("/v1/rounds", json!({"opens_at": future})).await;
    assert_eq!(a["opens_at_unix"], future);

    let iso = a["opens_at"].as_str().unwrap().to_string();
    let (_, b) = h.post("/v1/rounds", json!({"opens_at": iso})).await;
    assert_eq!(
        b["opens_at_unix"], future,
        "RFC 3339 round trip drifted: {b}"
    );
}
fn crate_unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}
/// The service describes itself, so limits live where the code enforcing them
/// lives rather than in prose that drifts.
#[tokio::test]
async fn v1_root_describes_the_service() {
    let h = harness().await;
    let (status, root) = h.get("/v1").await;
    assert_eq!(status, 200, "{root}");
    assert_eq!(root["version"], "v1");
    assert!(root["limits"]["max_payload_bytes"].as_i64().unwrap() > 0);
    assert!(root["limits"]["max_page_size"].as_i64().unwrap() > 0);

    let (status, params) = h.get("/v1/parameters").await;
    assert_eq!(status, 200, "{params}");
    assert_eq!(params["threshold"], 2);
    assert_eq!(params["operators"], 3);
    assert!(!params["parameters_b64"].as_str().unwrap().is_empty());
}
/// A client should be able to see its budget without being refused first.
#[tokio::test]
async fn rate_limit_headers_are_on_every_response() {
    let h = harness().await;
    let (status, _, headers) = h.get_full("/v1").await;
    assert_eq!(status, 200);
    assert!(headers.contains_key("ratelimit-limit"), "{headers:?}");
    let first: i64 = headers["ratelimit-remaining"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();

    let (_, _, headers) = h.get_full("/v1").await;
    let second: i64 = headers["ratelimit-remaining"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        second <= first,
        "remaining did not fall: {first} then {second}"
    );
}
/// A block-scheduled condition used to lose its tag on the way into the
/// database, so it could never be attributed to the app that created it.
#[tokio::test]
async fn a_block_scheduled_round_keeps_its_tag() {
    let h = harness().await;
    // v0, which is where the insert was missing the column.
    let (status, cond) = h
        .post(
            "/v0/conditions",
            json!({"committee_id": h.committee_id, "kind": "at_block",
                   "chain_id": 11155111, "height": 9_000_000, "tag": "blocky"}),
        )
        .await;
    // Without an RPC configured for that chain the request is refused, which is
    // a different correct behaviour; only assert the tag when it was accepted.
    if status == 200 {
        let id = cond["id"].as_str().unwrap();
        let (_, round) = h.get(&format!("/v1/rounds/{id}")).await;
        assert_eq!(round["tag"], "blocky", "{round}");
    } else {
        assert_eq!(status, 400, "{cond}");
    }
}
/// Listing an opened round's seals used to deadlock: the handler held the
/// database mutex and then asked for the reveal, which takes it again. The
/// mutex is not reentrant, so the coordinator stopped answering anything.
/// Every earlier test listed seals only while the round was still open.
#[tokio::test]
async fn v1_listing_seals_after_the_round_opens_returns_payloads() {
    let h = harness().await;
    let (_, round) = h
        .post("/v1/rounds", json!({"opens_in": 1, "tag": "listing"}))
        .await;
    let id = round["id"].as_str().unwrap().to_string();

    let mut rng = bte_crypto::os_rng();
    for text in [b"first".as_slice(), b"second"] {
        let ct = seal(&h.params, text, &mut rng).unwrap();
        h.post(
            &format!("/v1/rounds/{id}/seals"),
            json!({"ciphertext_b64": B64.encode(ct.to_bytes())}),
        )
        .await;
    }
    h.drive_to_reveal(&id).await;

    let listed = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        h.get(&format!("/v1/rounds/{id}/seals")),
    )
    .await
    .expect("listing seals after the reveal hung");

    let (status, body) = listed;
    assert_eq!(status, 200, "{body}");
    let data = body["data"].as_array().unwrap();
    assert_eq!(data.len(), 2, "{body}");
    let mut opened: Vec<String> = data
        .iter()
        .map(|s| {
            String::from_utf8(B64.decode(s["payload_b64"].as_str().unwrap()).unwrap()).unwrap()
        })
        .collect();
    opened.sort();
    assert_eq!(opened, vec!["first".to_string(), "second".to_string()]);

    // And the coordinator is still answering, which is the part that broke.
    let (status, _) = h.get("/v1").await;
    assert_eq!(status, 200, "the coordinator stopped responding");
}

/// A round can say what it is, so a bidder knows what they are bidding on
/// before anything opens.
///
/// This is PUBLIC and the test says so plainly: it is readable from creation,
/// unlike every payload sealed to the round.
#[tokio::test]
async fn v1_round_can_describe_itself() {
    let h = harness().await;
    let (status, round) = h
        .post(
            "/v1/rounds",
            json!({
                "opens_in": 600,
                "tag": "shop",
                "title": "Signed tour poster",
                "description": "One of a kind, ships worldwide.",
                "image_url": "https://images.example.com/poster.jpg",
            }),
        )
        .await;
    assert_eq!(status, 201, "{round}");
    assert_eq!(round["title"], "Signed tour poster");
    assert_eq!(round["image_url"], "https://images.example.com/poster.jpg");

    // It survives the round trip, and comes back on the list as well as the
    // single fetch: a gallery needs it without N+1 requests.
    let id = round["id"].as_str().unwrap();
    let (_, fetched) = h.get(&format!("/v1/rounds/{id}")).await;
    assert_eq!(fetched["description"], "One of a kind, ships worldwide.");
    let (_, listed) = h.get("/v1/rounds?tag=shop").await;
    assert_eq!(
        listed["data"][0]["image_url"],
        "https://images.example.com/poster.jpg"
    );

    // Absent stays absent rather than becoming an empty string.
    let (_, bare) = h.post("/v1/rounds", json!({"opens_in": 600})).await;
    assert_eq!(bare["title"], Value::Null);
    assert_eq!(bare["image_url"], Value::Null);
}

/// A picture address arrives from whoever created the round and is rendered by
/// everyone who opens it, so anything that is not an https URL is refused
/// rather than sanitised: the caller can fix it and we cannot guess.
#[tokio::test]
async fn v1_refuses_a_picture_that_is_not_https() {
    let h = harness().await;
    for bad in [
        "http://images.example.com/x.jpg",
        "javascript:alert(1)",
        "data:image/png;base64,AAAA",
        "//images.example.com/x.jpg",
        "https://images.example.com/a b.jpg",
    ] {
        let (status, body) = h
            .post("/v1/rounds", json!({"opens_in": 600, "image_url": bad}))
            .await;
        assert_eq!(status, 400, "accepted {bad}: {body}");
        assert_eq!(body["code"], "invalid_image_url", "{body}");
        assert_eq!(body["field"], "image_url");
    }

    // And the text has bounds, so one round cannot carry a novel.
    let (_, body) = h
        .post(
            "/v1/rounds",
            json!({"opens_in": 600, "title": "x".repeat(200)}),
        )
        .await;
    assert_eq!(body["code"], "invalid_title");
}

// -------------------------------------------------------------------- seo ---

/// Every page in the table appears in the sitemap unless it is deliberately a
/// live view rather than a document, and the sitemap is generated from the same
/// table as the pages, so it cannot fall behind them.
#[tokio::test]
async fn seo_sitemap_lists_every_indexable_page() {
    use bte_coordinator::pages;
    let xml = pages::sitemap("https://peal.network", "2026-09-04");
    for page in pages::PAGES.iter().filter(|p| p.index) {
        let loc = if page.path.is_empty() {
            "<loc>https://peal.network</loc>".to_string()
        } else {
            format!("<loc>https://peal.network/{}</loc>", page.path)
        };
        assert!(xml.contains(&loc), "sitemap is missing {}", page.path);
    }
    for page in pages::PAGES.iter().filter(|p| !p.index) {
        assert!(
            !xml.contains(&format!("/{}</loc>", page.path)),
            "{} is a live view and should not be in the sitemap",
            page.path
        );
    }
    assert!(xml.starts_with("<?xml"));
}

/// robots.txt must be robots.txt. It used to fall through to the SPA and answer
/// with an HTML page, which is a worse answer than a 404 to the crawler
/// deciding whether the rest of the site is worth reading.
#[tokio::test]
async fn seo_robots_points_at_the_sitemap_and_keeps_crawlers_out_of_the_api() {
    let robots = bte_coordinator::pages::robots("https://peal.network");
    assert!(robots.starts_with("User-agent: *"));
    assert!(robots.contains("Sitemap: https://peal.network/sitemap.xml"));
    // The API is for programs. Crawling it spends everyone's budget for nothing.
    assert!(robots.contains("Disallow: /v0/"));
    assert!(robots.contains("Disallow: /v1/"));
}

/// The structured data has to parse, and its nodes have to be distinct: two
/// nodes of one type with different ids is a graph a parser has to guess at.
#[tokio::test]
async fn seo_structured_data_is_a_well_formed_graph() {
    use bte_coordinator::pages;
    for page in pages::PAGES {
        let script = pages::json_ld(page, "https://peal.network");
        let json = script
            .trim_start_matches("<script type=\"application/ld+json\">")
            .trim_end_matches("</script>");
        let parsed: Value = serde_json::from_str(json)
            .unwrap_or_else(|e| panic!("{} produced invalid JSON-LD: {e}", page.path));
        let graph = parsed["@graph"].as_array().unwrap();
        assert!(!graph.is_empty(), "{} has an empty graph", page.path);

        let ids: Vec<&str> = graph.iter().filter_map(|n| n["@id"].as_str()).collect();
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(ids.len(), unique.len(), "{} repeats an @id", page.path);
    }

    // The home page carries the product itself, which is the node an answer
    // engine reads when somebody asks what this is.
    let home = pages::json_ld(&pages::PAGES[0], "https://peal.network");
    assert!(home.contains("\"SoftwareApplication\""));
    assert!(home.contains("\"Organization\""));

    // And the developer page answers the questions people actually ask.
    let devs = pages::find("developers").unwrap();
    let ld = pages::json_ld(devs, "https://peal.network");
    assert!(ld.contains("\"FAQPage\""));
    assert!(ld.contains("How do I encrypt data until a specific time?"));
}

/// llms.txt is the one piece of answer engine optimisation entirely under our
/// control: it is what a model reads when asked what this is.
#[tokio::test]
async fn seo_llms_txt_describes_the_product_and_links_the_pages() {
    let txt = bte_coordinator::pages::llms_txt("https://peal.network");
    assert!(txt.starts_with("# Peal Network"));
    // The convention is a blockquote summary directly under the heading.
    assert!(txt.contains("\n> Peal is an API"));
    // The three calls, so a model can answer "how do I use it" concretely.
    assert!(txt.contains("POST https://peal.network/v1/rounds"));
    for page in bte_coordinator::pages::PAGES.iter().filter(|p| p.index) {
        assert!(
            txt.contains(page.title),
            "llms.txt is missing {}",
            page.path
        );
    }
}

/// A page path must never be treated as an auction name, and vice versa.
#[tokio::test]
async fn seo_page_paths_and_auction_names_do_not_collide() {
    use bte_coordinator::pages;
    assert!(pages::find("developers").is_some());
    assert!(
        pages::find("/protocol/").is_some(),
        "slashes should be tolerated"
    );
    assert!(pages::find("nepal-relief").is_none());
    assert!(pages::find("").is_some(), "the empty path is the home page");
}
