//! The DKG through the coordinator's relay: five operators, each driven by
//! the node's `RoundDriver` over HTTP, produce a v1 committee that the
//! coordinator registers; then a condition on that committee seals,
//! freezes, collects four shares and reveals. Also: the relay refuses an
//! envelope from a stranger, and a round short of dealers fails once its
//! deadline passes.

use base64::Engine;
use bte_coordinator::{api, db, engine, state};
use bte_crypto::tbte::wire::unpack_headers;
use bte_crypto::tbte::{self, dkg::Envelope};
use bte_node::dkg_client::{Progress, Relay, RoundDriver};
use bte_node::identity::OperatorIdentity;
use bte_node::v1store::{open_share, seal_share};
use serde_json::{json, Value};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

struct Harness {
    app: state::App,
    base: String,
    client: reqwest::Client,
}

async fn harness() -> Harness {
    let conn = db::open(":memory:").unwrap();
    let mut cfg = state::Config::from_env();
    // What `BTE_DEV=1` on a loopback listen address grants.
    cfg.admin_waiver = true;
    let app = state::App::new(conn, cfg).unwrap();
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

    async fn start_round(&self, operators: &[OperatorIdentity], ack_timeout_secs: i64) -> Value {
        let entries: Vec<Value> = operators.iter().map(entry).collect();
        let (status, round) = self
            .post(
                "/v0/dkg/rounds",
                json!({"committee_tag": "test", "operators": entries, "ack_timeout_secs": ack_timeout_secs}),
            )
            .await;
        assert_eq!(status, 200, "{round}");
        round
    }
}

fn entry(o: &OperatorIdentity) -> Value {
    json!({"identity": o.key_hex(), "box": o.box_hex(), "box_sig": o.box_sig_hex()})
}

/// One private seed directory per operator, kept for the test's lifetime.
fn seed_dirs(n: usize) -> Vec<tempfile::TempDir> {
    (0..n).map(|_| tempfile::tempdir().unwrap()).collect()
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// Drive every operator until the round settles or `max_steps` pass.
async fn drive(
    h: &Harness,
    relay: &Relay,
    operators: &[OperatorIdentity],
    drivers: &mut [RoundDriver],
    max_steps: usize,
) -> Vec<Progress> {
    let mut last = Vec::new();
    for _ in 0..max_steps {
        last.clear();
        for (me, driver) in operators.iter().zip(drivers.iter_mut()) {
            last.push(driver.step(me, relay, now()).await.unwrap());
        }
        engine::tick(&h.app).await.unwrap();
        if last
            .iter()
            .all(|p| matches!(p, Progress::Done | Progress::Failed(_)))
        {
            break;
        }
    }
    last
}

#[tokio::test]
async fn five_operators_make_a_committee_over_the_relay_and_it_reveals() {
    let h = harness().await;
    let operators: Vec<OperatorIdentity> = (0..5).map(|_| OperatorIdentity::generate()).collect();
    let round = h.start_round(&operators, 60).await;
    let round_id = round["id"].as_str().unwrap().to_string();
    assert_eq!(round["n"], json!(5));
    assert_eq!(round["threshold"], json!(4));
    assert_eq!(round["status"], json!("open"));

    let relay = Relay::new(h.base.clone());
    let dirs = seed_dirs(operators.len());
    // Each node discovers its round from the relay.
    let mut drivers = Vec::new();
    for (me, dir) in operators.iter().zip(&dirs) {
        let rounds = relay.rounds_for(&me.key_hex()).await.unwrap();
        assert_eq!(rounds.len(), 1);
        drivers.push(RoundDriver::new(me, rounds[0].clone(), dir.path()).unwrap());
    }
    let progress = drive(&h, &relay, &operators, &mut drivers, 20).await;
    assert!(
        progress.iter().all(|p| *p == Progress::Done),
        "{progress:?}"
    );

    let (_, settled) = h.get(&format!("/v0/dkg/rounds/{round_id}")).await;
    assert_eq!(settled["status"], json!("complete"), "{settled}");
    let committee_id = settled["committee_id"].as_str().unwrap().to_string();
    assert_eq!(settled["logs"].as_array().unwrap().len(), 5);

    // Every operator's share matches the registered committee, and the
    // share store round-trips it.
    let (_, committee) = h.get(&format!("/v0/committees/{committee_id}")).await;
    assert_eq!(committee["scheme"], json!("v1"));
    assert_eq!(committee["n"], json!(5));
    assert_eq!(committee["t"], json!(4));
    let params_blob = B64
        .decode(committee["params_b64"].as_str().unwrap())
        .unwrap();
    let params = tbte::PublicParams::from_bytes(&params_blob).unwrap();
    let mut held = Vec::new();
    for driver in &drivers {
        let result = driver.result.as_ref().unwrap();
        assert_eq!(result.params.digest(), params.digest());
        let secret = result.secret.as_ref().unwrap();
        assert_eq!(
            secret.public_key(),
            params.operator_keys()[secret.party_index as usize - 1]
        );
        let file = seal_share(&committee_id, &params, secret, "pw").unwrap();
        held.push(open_share(&file, "pw").unwrap());
    }

    // The committee works end to end through the coordinator.
    let (status, cond) = h
        .post(
            "/v0/conditions",
            json!({"committee_id": committee_id, "in_secs": 0}),
        )
        .await;
    assert_eq!(status, 200, "{cond}");
    let condition_id = cond["id"].as_str().unwrap().to_string();
    let mut rng = bte_crypto::os_rng();
    let ct = tbte::seal(
        &params,
        &tbte::condition_context(&condition_id),
        b"dkg-backed seal",
        &mut rng,
    )
    .unwrap();
    let (status, resp) = h
        .post(
            "/v0/ciphertexts",
            json!({"condition_id": condition_id, "sealed_blob_b64": B64.encode(ct.to_bytes())}),
        )
        .await;
    assert_eq!(status, 200, "{resp}");
    engine::tick(&h.app).await.unwrap();
    for op in &held[..4] {
        let (_, work) = h
            .get(&format!("/v0/work?operator={}", op.party_index))
            .await;
        let batches = work["batches"].as_array().unwrap();
        assert_eq!(batches.len(), 1);
        let raw = B64
            .decode(batches[0]["headers_b64"].as_str().unwrap())
            .unwrap();
        let headers = unpack_headers(&raw).unwrap();
        let share = tbte::partial(&op.params, &op.secret, &headers).unwrap();
        let (status, resp) = h
            .post(
                "/v0/shares",
                json!({"batch_id": batches[0]["batch_id"], "operator_id": op.party_index, "share_b64": B64.encode(share.to_bytes())}),
            )
            .await;
        assert_eq!(status, 200);
        assert_eq!(resp["verified"], json!(true), "{resp}");
    }
    engine::tick(&h.app).await.unwrap();
    let (status, reveal) = h.get(&format!("/v0/reveals/{condition_id}")).await;
    assert_eq!(status, 200, "{reveal}");
    let real: Vec<&Value> = reveal["slots"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["is_dummy"] == json!(false))
        .collect();
    assert_eq!(real.len(), 1);
    assert_eq!(
        B64.decode(real[0]["payload_b64"].as_str().unwrap())
            .unwrap(),
        b"dkg-backed seal"
    );
}

#[tokio::test]
async fn relay_refuses_strangers_and_needs_admin_to_start_rounds() {
    let h = harness().await;
    let operators: Vec<OperatorIdentity> = (0..4).map(|_| OperatorIdentity::generate()).collect();
    let round = h.start_round(&operators, 60).await;
    let round_id = round["id"].as_str().unwrap().to_string();
    let digest: [u8; 32] = hex::decode(round["digest"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();

    // A stranger's envelope is refused; a member's is stored once.
    let stranger = OperatorIdentity::generate();
    let e = Envelope::sign(
        &stranger.identity,
        digest,
        tbte::dkg::Kind::DealerPublic,
        None,
        vec![1, 2, 3],
    );
    let (status, resp) = h
        .post(
            &format!("/v0/dkg/rounds/{round_id}/envelopes"),
            json!({"envelope_b64": B64.encode(e.to_bytes())}),
        )
        .await;
    assert_eq!(status, 400, "{resp}");
    let e = Envelope::sign(
        &operators[0].identity,
        digest,
        tbte::dkg::Kind::DealerPublic,
        None,
        vec![1, 2, 3],
    );
    let body = json!({"envelope_b64": B64.encode(e.to_bytes())});
    let (status, resp) = h
        .post(
            &format!("/v0/dkg/rounds/{round_id}/envelopes"),
            body.clone(),
        )
        .await;
    assert_eq!(status, 200, "{resp}");
    assert_eq!(resp["accepted"], json!(true));
    let (_, resp) = h
        .post(&format!("/v0/dkg/rounds/{round_id}/envelopes"), body)
        .await;
    assert_eq!(resp["accepted"], json!(false), "duplicate keeps the first");
    // An envelope for another round digest is refused.
    let e = Envelope::sign(
        &operators[1].identity,
        [9u8; 32],
        tbte::dkg::Kind::DealerPublic,
        None,
        vec![1],
    );
    let (status, _) = h
        .post(
            &format!("/v0/dkg/rounds/{round_id}/envelopes"),
            json!({"envelope_b64": B64.encode(e.to_bytes())}),
        )
        .await;
    assert_eq!(status, 400);

    // Without the waiver and without a token, starting a round is refused.
    let conn = db::open(":memory:").unwrap();
    let mut cfg = state::Config::from_env();
    cfg.admin_waiver = false;
    cfg.admin_token = Some("secret-token".into());
    let app = state::App::new(conn, cfg).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, api::router(app)).await.unwrap();
    });
    let entries: Vec<Value> = operators.iter().map(entry).collect();
    let body = json!({"committee_tag": "locked", "operators": entries});
    let resp = h
        .client
        .post(format!("{base}/v0/dkg/rounds"))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 401);
    let resp = h
        .client
        .post(format!("{base}/v0/dkg/rounds"))
        .header("x-bte-admin", "secret-token")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
}

#[tokio::test]
async fn a_round_missing_dealers_fails_after_its_deadline() {
    let h = harness().await;
    let operators: Vec<OperatorIdentity> = (0..4).map(|_| OperatorIdentity::generate()).collect();
    // Deadline already in the past: dealers close at once with reveals.
    let round = h.start_round(&operators, 5).await;
    let round_id = round["id"].as_str().unwrap().to_string();
    let relay = Relay::new(h.base.clone());
    // Only two of four operators ever show up (quorum is three).
    let active = &operators[..2];
    let dirs = seed_dirs(2);
    let mut drivers: Vec<RoundDriver> = Vec::new();
    for (me, dir) in active.iter().zip(&dirs) {
        let rounds = relay.rounds_for(&me.key_hex()).await.unwrap();
        drivers.push(RoundDriver::new(me, rounds[0].clone(), dir.path()).unwrap());
    }
    // Push the clock past the deadline and the grace period by editing the row.
    {
        let conn = h.app.0.db.lock().unwrap();
        conn.execute(
            "UPDATE dkg_rounds SET ack_deadline = ?2 WHERE id = ?1",
            rusqlite::params![round_id, now() - 1000],
        )
        .unwrap();
    }
    let progress = drive(&h, &relay, active, &mut drivers, 6).await;
    assert!(
        progress.iter().all(|p| matches!(p, Progress::Failed(_))),
        "{progress:?}"
    );
    let (_, settled) = h.get(&format!("/v0/dkg/rounds/{round_id}")).await;
    assert_eq!(settled["status"], json!("failed"), "{settled}");
    assert!(settled["error"].as_str().unwrap().contains("quorum"));
    // No committee was registered.
    let (_, list) = h.get("/v0/committees").await;
    assert!(list["committees"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn a_node_restarted_mid_round_rebuilds_from_the_relay_and_finishes() {
    let h = harness().await;
    let operators: Vec<OperatorIdentity> = (0..5).map(|_| OperatorIdentity::generate()).collect();
    h.start_round(&operators, 60).await;
    let relay = Relay::new(h.base.clone());
    let dirs = seed_dirs(operators.len());
    let mut drivers = Vec::new();
    for (me, dir) in operators.iter().zip(&dirs) {
        let rounds = relay.rounds_for(&me.key_hex()).await.unwrap();
        drivers.push(RoundDriver::new(me, rounds[0].clone(), dir.path()).unwrap());
    }
    // One step each: every dealing and most acknowledgements are on the relay.
    for (me, driver) in operators.iter().zip(drivers.iter_mut()) {
        driver.step(me, &relay, now()).await.unwrap();
    }
    // Operator 2 "crashes": its in-memory state is gone. A fresh driver from
    // the same identity must regenerate the same dealing (the relay keeps the
    // first copy, so a different one would be refused as a duplicate and the
    // acknowledgements already given would not match) and replay the rest.
    let info = relay.rounds_for(&operators[2].key_hex()).await.unwrap()[0].clone();
    let before = relay.envelopes(&info.id, 0).await.unwrap().len();
    drivers[2] = RoundDriver::new(&operators[2], info.clone(), dirs[2].path()).unwrap();
    let progress = drive(&h, &relay, &operators, &mut drivers, 20).await;
    assert!(
        progress.iter().all(|p| *p == Progress::Done),
        "{progress:?}"
    );
    // The restarted node re-posted nothing new before its log: same dealing,
    // same acknowledgements, all deduplicated by the relay.
    let after = relay.envelopes(&info.id, 0).await.unwrap();
    let from_two = after
        .iter()
        .filter(|(_, e)| e.from == operators[2].key())
        .count();
    // 1 public + 5 private (one to itself) + 5 acks + 1 log.
    assert_eq!(from_two, 12, "operator 2 has exactly one envelope per slot");
    assert!(after.len() >= before);
    let (_, settled) = h.get(&format!("/v0/dkg/rounds/{}", info.id)).await;
    assert_eq!(settled["status"], json!("complete"));
    let params_digest = settled["committee_id"].as_str().unwrap();
    for (i, driver) in drivers.iter().enumerate() {
        let result = driver.result.as_ref().unwrap();
        assert_eq!(hex::encode(result.params.digest()), params_digest);
        let secret = result.secret.as_ref().unwrap();
        assert_eq!(
            secret.public_key(),
            result.params.operator_keys()[secret.party_index as usize - 1],
            "operator {i}"
        );
    }
}

#[tokio::test]
async fn a_node_refuses_to_deal_one_digest_under_a_second_round_id() {
    // The relay serving the same (tag, round, operators) under another id
    // would make honest dealers reuse their polynomial; the node keeps the
    // seed keyed by digest with the id it was dealt under and refuses.
    let h = harness().await;
    let operators: Vec<OperatorIdentity> = (0..4).map(|_| OperatorIdentity::generate()).collect();
    let round = h.start_round(&operators, 60).await;
    let relay = Relay::new(h.base.clone());
    let dir = tempfile::tempdir().unwrap();
    let mut info = relay.rounds_for(&operators[0].key_hex()).await.unwrap()[0].clone();
    assert_eq!(info.id, round["id"].as_str().unwrap());
    let driver = RoundDriver::new(&operators[0], info.clone(), dir.path()).unwrap();
    let digest = driver.config().digest();
    // The relay id is part of the digest, so a second id is a different
    // digest and a different (fresh) seed: two rounds, not a replay.
    info.id = "dkg_forged".into();
    assert!(
        RoundDriver::new(&operators[0], info.clone(), dir.path()).is_err(),
        "digest mismatch"
    );
    // A replay of the very same digest under another id is refused too.
    let seed_file = dir.path().join(format!("dkg-{}.seed", hex::encode(digest)));
    assert!(seed_file.exists());
    let mut bytes = std::fs::read(&seed_file).unwrap();
    // Rewrite the recorded id: the seed now claims to belong to another round.
    let cut = bytes.iter().position(|b| *b == b'\n').unwrap();
    let seed = bytes.split_off(cut);
    let mut forged = b"dkg_other".to_vec();
    forged.extend_from_slice(&seed);
    std::fs::write(&seed_file, forged).unwrap();
    let info = relay.rounds_for(&operators[0].key_hex()).await.unwrap()[0].clone();
    let err = match RoundDriver::new(&operators[0], info, dir.path()) {
        Ok(_) => panic!("the replayed digest must be refused"),
        Err(e) => e,
    };
    assert!(
        err.to_string().contains("refusing to deal it again"),
        "{err}"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&seed_file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "seed files are private");
    }
}

#[tokio::test]
async fn relay_rejects_bad_logs_at_the_door_and_unsigned_box_keys() {
    let h = harness().await;
    let operators: Vec<OperatorIdentity> = (0..4).map(|_| OperatorIdentity::generate()).collect();
    // A box key without its operator's signature is refused when the round
    // is created (a relay could otherwise substitute one it holds).
    let mut entries: Vec<Value> = operators.iter().map(entry).collect();
    entries[1]["box_sig"] = json!("");
    let (status, resp) = h
        .post(
            "/v0/dkg/rounds",
            json!({"committee_tag": "unsigned", "operators": entries}),
        )
        .await;
    assert_eq!(status, 400, "{resp}");
    // Duplicate identities are refused too.
    let mut entries: Vec<Value> = operators.iter().map(entry).collect();
    entries[1] = entries[0].clone();
    let (status, _) = h
        .post(
            "/v0/dkg/rounds",
            json!({"committee_tag": "dup", "operators": entries}),
        )
        .await;
    assert_eq!(status, 400);

    let round = h.start_round(&operators, 60).await;
    let round_id = round["id"].as_str().unwrap().to_string();
    let digest: [u8; 32] = hex::decode(round["digest"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    // A member posting garbage as its signed log is refused at the door, so
    // it can never fail the round later.
    let e = Envelope::sign(
        &operators[3].identity,
        digest,
        tbte::dkg::Kind::Log,
        None,
        vec![7u8; 100],
    );
    let (status, resp) = h
        .post(
            &format!("/v0/dkg/rounds/{round_id}/envelopes"),
            json!({"envelope_b64": B64.encode(e.to_bytes())}),
        )
        .await;
    assert_eq!(status, 400, "{resp}");
    assert!(resp["error"].as_str().unwrap().contains("signed log"));
    // Oversized payloads for their kind are refused.
    let e = Envelope::sign(
        &operators[3].identity,
        digest,
        tbte::dkg::Kind::Ack,
        Some(operators[0].key()),
        vec![0u8; 4096],
    );
    let (status, _) = h
        .post(
            &format!("/v0/dkg/rounds/{round_id}/envelopes"),
            json!({"envelope_b64": B64.encode(e.to_bytes())}),
        )
        .await;
    assert_eq!(status, 400);

    // Three honest operators of four still complete the round while the
    // fourth posts nothing usable.
    let relay = Relay::new(h.base.clone());
    let dirs = seed_dirs(3);
    let active = &operators[..3];
    let mut drivers = Vec::new();
    for (me, dir) in active.iter().zip(&dirs) {
        let rounds = relay.rounds_for(&me.key_hex()).await.unwrap();
        drivers.push(RoundDriver::new(me, rounds[0].clone(), dir.path()).unwrap());
    }
    // The honest three exchange dealings and acknowledgements first ...
    for _ in 0..2 {
        for (me, driver) in active.iter().zip(drivers.iter_mut()) {
            driver.step(me, &relay, now()).await.unwrap();
        }
    }
    // ... then the deadline passes: each closes with one reveal (for the
    // absent fourth), within the fault model's bound, and the round settles.
    {
        let conn = h.app.0.db.lock().unwrap();
        conn.execute(
            "UPDATE dkg_rounds SET ack_deadline = ?2 WHERE id = ?1",
            rusqlite::params![round_id, now() - 100],
        )
        .unwrap();
    }
    let progress = drive(&h, &relay, active, &mut drivers, 20).await;
    assert!(
        progress.iter().all(|p| *p == Progress::Done),
        "{progress:?}"
    );
}

#[tokio::test]
async fn registering_a_committee_needs_admin_and_never_takes_v1_params() {
    let conn = db::open(":memory:").unwrap();
    let mut cfg = state::Config::from_env();
    cfg.admin_waiver = false;
    cfg.admin_token = Some("tok".into());
    let app = state::App::new(conn, cfg).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, api::router(app)).await.unwrap();
    });
    let client = reqwest::Client::new();
    let mut rng = bte_crypto::os_rng();
    let (v0, _) = bte_crypto::ceremony(3, 2, 4, &mut rng).unwrap();
    let body = json!({"params_b64": B64.encode(v0.to_bytes())});
    let resp = client
        .post(format!("{base}/v0/committees"))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 401, "anonymous registration");
    let resp = client
        .post(format!("{base}/v0/committees"))
        .header("x-bte-admin", "tok")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let (v1, _) = tbte::dev::deal(3, 2, &mut rng).unwrap();
    let resp = client
        .post(format!("{base}/v0/committees"))
        .header("x-bte-admin", "tok")
        .json(&json!({"params_b64": B64.encode(v1.to_bytes())}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status().as_u16(),
        400,
        "v1 params only come from a DKG round"
    );
}
