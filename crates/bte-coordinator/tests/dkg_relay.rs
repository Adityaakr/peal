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
    std::env::set_var("BTE_DEV", "1");
    let conn = db::open(":memory:").unwrap();
    let app = state::App::new(conn, state::Config::from_env()).unwrap();
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
        let entries: Vec<Value> = operators
            .iter()
            .map(|o| json!({"identity": o.key_hex(), "box": o.box_hex()}))
            .collect();
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
    // Each node discovers its round from the relay.
    let mut drivers = Vec::new();
    for me in &operators {
        let rounds = relay.rounds_for(&me.key_hex()).await.unwrap();
        assert_eq!(rounds.len(), 1);
        drivers.push(RoundDriver::new(me, rounds[0].clone()).unwrap());
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

    // Without the dev flag and without a token, starting a round is refused.
    std::env::remove_var("BTE_DEV");
    let conn = db::open(":memory:").unwrap();
    let mut cfg = state::Config::from_env();
    cfg.dev = false;
    cfg.admin_token = Some("secret-token".into());
    let app = state::App::new(conn, cfg).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, api::router(app)).await.unwrap();
    });
    let entries: Vec<Value> = operators
        .iter()
        .map(|o| json!({"identity": o.key_hex(), "box": o.box_hex()}))
        .collect();
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
    std::env::set_var("BTE_DEV", "1");
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
    let mut drivers: Vec<RoundDriver> = Vec::new();
    for me in active {
        let rounds = relay.rounds_for(&me.key_hex()).await.unwrap();
        drivers.push(RoundDriver::new(me, rounds[0].clone()).unwrap());
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
