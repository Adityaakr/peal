//! In-process integration tests for a BTE v1 (transparent setup) committee:
//! proof-checked intake bound to the condition, single-batch freeze with one
//! decoy, verified shares, reveal; and the door refusing what it must.

use base64::Engine;
use bte_coordinator::{api, db, engine, state};
use bte_crypto::rand::SeedableRng;
use bte_crypto::tbte::wire::{unpack_headers, HEADER_BYTES};
use bte_crypto::tbte::{self, dev::deal, OperatorSecret, PublicParams};
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

/// Coordinator with an in-memory db and a registered v1 committee (n=5, t=3,
/// dealt in-process for the test; the product path is the DKG).
async fn harness() -> Harness {
    let mut rng = ChaCha20Rng::seed_from_u64(11);
    let (params, secrets) = deal(5, 3, &mut rng).unwrap();
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

    async fn condition(&self) -> String {
        let (status, cond) = self
            .post(
                "/v0/conditions",
                json!({"committee_id": self.committee_id, "in_secs": 0}),
            )
            .await;
        assert_eq!(status, 200, "{cond}");
        cond["id"].as_str().unwrap().to_string()
    }

    fn seal_for(&self, condition_id: &str, payload: &[u8]) -> tbte::Ciphertext {
        let mut rng = bte_crypto::os_rng();
        tbte::seal(
            &self.params,
            &tbte::condition_context(condition_id),
            payload,
            &mut rng,
        )
        .unwrap()
    }

    async fn submit(&self, condition_id: &str, ct: &tbte::Ciphertext) -> (u16, Value) {
        self.post(
            "/v0/ciphertexts",
            json!({
                "condition_id": condition_id,
                "sealed_blob_b64": B64.encode(ct.to_bytes()),
            }),
        )
        .await
    }

    async fn work_and_share(&self, operator: &OperatorSecret) -> usize {
        let (status, work) = self
            .get(&format!("/v0/work?operator={}", operator.party_index))
            .await;
        assert_eq!(status, 200);
        let batches = work["batches"].as_array().unwrap();
        for batch in batches {
            assert_eq!(batch["scheme"], json!("v1"));
            assert_eq!(batch["committee_id"], json!(self.committee_id));
            let raw = B64.decode(batch["headers_b64"].as_str().unwrap()).unwrap();
            assert_eq!(raw.len() % HEADER_BYTES, 0);
            let headers = unpack_headers(&raw).unwrap();
            assert_eq!(headers.len() as u64, batch["slots"].as_u64().unwrap());
            let share = tbte::partial(&self.params, operator, &headers).unwrap();
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
async fn v1_full_flow_seal_freeze_shares_reveal() {
    let h = harness().await;
    let (status, committee) = h.get("/v0/committees/default").await;
    assert_eq!(status, 200);
    assert_eq!(committee["scheme"], json!("v1"));
    assert_eq!(committee["n"], json!(5));
    assert_eq!(committee["t"], json!(3));
    assert!(committee["setup_digest"].as_str().is_some());
    let (_, params) = h.get("/v1/parameters").await;
    assert_eq!(params["scheme"], json!("v1"));

    let condition_id = h.condition().await;
    let payloads: Vec<Vec<u8>> = ["bid: alice 100", "bid: bob 250", "bid: carol 175"]
        .iter()
        .map(|s| s.as_bytes().to_vec())
        .collect();
    let mut hashes = Vec::new();
    for p in &payloads {
        let ct = h.seal_for(&condition_id, p);
        let (status, resp) = h.submit(&condition_id, &ct).await;
        assert_eq!(status, 200, "{resp}");
        hashes.push(resp["ct_hash"].as_str().unwrap().to_string());
    }

    // Nothing is readable before the reveal.
    let (status, _) = h.get(&format!("/v0/reveals/{condition_id}")).await;
    assert_eq!(status, 404);

    engine::tick(&h.app).await.unwrap();
    let (_, cond) = h.get(&format!("/v0/conditions/{condition_id}")).await;
    assert_eq!(cond["status"], json!("frozen"), "{cond}");

    // Three of five operators (t = 3 for the dealt fixture).
    for op in &h.secrets[..3] {
        assert_eq!(h.work_and_share(op).await, 1, "one batch per v1 condition");
    }
    engine::tick(&h.app).await.unwrap();

    let (status, reveal) = h.get(&format!("/v0/reveals/{condition_id}")).await;
    assert_eq!(status, 200, "{reveal}");
    let slots = reveal["slots"].as_array().unwrap();
    // Three real slots and exactly one coordinator decoy.
    assert_eq!(slots.len(), 4);
    let mut real = 0;
    for slot in slots {
        assert_eq!(slot["valid"], json!(true), "{slot}");
        if slot["is_dummy"] == json!(false) {
            real += 1;
            let payload = B64.decode(slot["payload_b64"].as_str().unwrap()).unwrap();
            assert!(payloads.contains(&payload));
            assert!(hashes.contains(&slot["ct_hash"].as_str().unwrap().to_string()));
        } else {
            let payload = B64.decode(slot["payload_b64"].as_str().unwrap()).unwrap();
            assert!(bte_crypto::is_dummy_payload(&payload));
        }
    }
    assert_eq!(real, 3);
    // Real positions come first, in ct_hash order (invariant 6).
    let mut sorted = hashes.clone();
    sorted.sort();
    for (i, slot) in slots
        .iter()
        .filter(|s| s["is_dummy"] == json!(false))
        .enumerate()
    {
        assert_eq!(slot["position"], json!(i as u32));
        assert_eq!(slot["ct_hash"], json!(sorted[i]));
    }
    // The reveal ships v1 headers a third party can check the shares against.
    let batch = &reveal["batches"][0];
    let raw = B64.decode(batch["headers_b64"].as_str().unwrap()).unwrap();
    let headers = unpack_headers(&raw).unwrap();
    assert_eq!(headers.len(), 4);
    for share in reveal["shares"].as_array().unwrap() {
        let blob = B64.decode(share["share_b64"].as_str().unwrap()).unwrap();
        let share = tbte::Share::from_bytes(&blob).unwrap();
        assert!(tbte::verify_share(&h.params, &headers, &share));
    }
}

#[tokio::test]
async fn v1_intake_refuses_wrong_condition_bad_proof_and_duplicate_randomness() {
    let h = harness().await;
    let a = h.condition().await;
    let b = h.condition().await;

    // Sealed for condition B, submitted to A.
    let for_b = h.seal_for(&b, b"for b");
    let (status, resp) = h.submit(&a, &for_b).await;
    assert_eq!(status, 400, "{resp}");
    assert!(resp["error"]
        .as_str()
        .unwrap()
        .contains("another condition"));
    let (status, _) = h.submit(&b, &for_b).await;
    assert_eq!(status, 200);

    // A ciphertext for another committee's key does not verify here.
    let mut rng = ChaCha20Rng::seed_from_u64(12);
    let (other_params, _) = deal(3, 2, &mut rng).unwrap();
    let foreign = tbte::seal(&other_params, &tbte::condition_context(&a), b"x", &mut rng).unwrap();
    let (status, resp) = h.submit(&a, &foreign).await;
    assert_eq!(status, 400, "{resp}");
    assert!(resp["error"].as_str().unwrap().contains("proof"));

    // A mauled proof is refused.
    let mut mauled = h.seal_for(&a, b"mauled");
    mauled.body[0] ^= 1;
    let (status, _) = h.submit(&a, &mauled).await;
    assert_eq!(status, 400);

    // The same randomness twice under one condition: second one refused,
    // even though its content hash differs.
    let pair = tbte::dev::seal_negated_pair(&h.params, &tbte::condition_context(&a), &mut rng);
    let (status, _) = h.submit(&a, &pair[0]).await;
    assert_eq!(status, 200);
    let mut same_k = pair[0].clone();
    same_k.body.push(0);
    let (status, resp) = h.submit(&a, &same_k).await;
    assert_eq!(status, 400, "{resp}");

    // A v0 ciphertext is not accepted by a v1 committee.
    let (v0_params, _) = bte_crypto::ceremony(3, 2, 4, &mut rng).unwrap();
    let v0 = bte_crypto::seal(&v0_params, b"v0", &mut rng).unwrap();
    let (status, resp) = h
        .post(
            "/v0/ciphertexts",
            json!({"condition_id": a, "sealed_blob_b64": B64.encode(v0.to_bytes())}),
        )
        .await;
    assert_eq!(status, 400, "{resp}");
    assert!(resp["error"].as_str().unwrap().contains("v0"));
}

#[tokio::test]
async fn v1_negated_pair_cannot_stall_the_condition() {
    // A sealer's (k, -k) pair passes intake (both proofs verify, distinct
    // randomness) but would make the batch's randomness sum to zero. The
    // coordinator's decoy fixes the sum, so the batch still opens.
    let h = harness().await;
    let c = h.condition().await;
    let mut rng = ChaCha20Rng::seed_from_u64(13);
    let pair = tbte::dev::seal_negated_pair(&h.params, &tbte::condition_context(&c), &mut rng);
    for ct in &pair {
        let (status, resp) = h.submit(&c, ct).await;
        assert_eq!(status, 200, "{resp}");
    }
    engine::tick(&h.app).await.unwrap();
    for op in &h.secrets[..3] {
        h.work_and_share(op).await;
    }
    engine::tick(&h.app).await.unwrap();
    let (status, reveal) = h.get(&format!("/v0/reveals/{c}")).await;
    assert_eq!(status, 200, "{reveal}");
    let slots = reveal["slots"].as_array().unwrap();
    assert_eq!(slots.len(), 3);
    // The pair's raw bodies are not DEM outputs: their slots open invalid,
    // the decoy opens fine, and nobody else was in the batch to be hurt.
    let valid: Vec<bool> = slots.iter().map(|s| s["valid"] == json!(true)).collect();
    assert_eq!(valid.iter().filter(|v| **v).count(), 1);
}

#[tokio::test]
async fn v1_rejected_share_is_flagged_and_never_counted() {
    let h = harness().await;
    let c = h.condition().await;
    let ct = h.seal_for(&c, b"only one");
    h.submit(&c, &ct).await;
    engine::tick(&h.app).await.unwrap();

    // Operator 1 posts a wire-valid but wrong share.
    let (_, work) = h.get("/v0/work?operator=1").await;
    let batch_id = work["batches"][0]["batch_id"].clone();
    let raw = B64
        .decode(work["batches"][0]["headers_b64"].as_str().unwrap())
        .unwrap();
    let headers = unpack_headers(&raw).unwrap();
    let honest = tbte::partial(&h.params, &h.secrets[1], &headers).unwrap();
    let wrong = tbte::Share {
        party_index: 1,
        value: honest.value,
    };
    let (status, resp) = h
        .post(
            "/v0/shares",
            json!({"batch_id": batch_id, "operator_id": 1, "share_b64": B64.encode(wrong.to_bytes())}),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(resp["verified"], json!(false));

    // Two honest shares are not enough with t = 3; a third honest one is.
    for op in &h.secrets[1..3] {
        h.work_and_share(op).await;
    }
    engine::tick(&h.app).await.unwrap();
    let (status, _) = h.get(&format!("/v0/reveals/{c}")).await;
    assert_eq!(status, 404, "rejected share must not count toward t");
    h.work_and_share(&h.secrets[3]).await;
    engine::tick(&h.app).await.unwrap();
    let (status, reveal) = h.get(&format!("/v0/reveals/{c}")).await;
    assert_eq!(status, 200);
    let rejected = reveal["shares"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["verified"] == json!(false))
        .count();
    assert_eq!(rejected, 1);
}

#[tokio::test]
async fn v1_empty_condition_reveals_a_lone_decoy() {
    let h = harness().await;
    let c = h.condition().await;
    engine::tick(&h.app).await.unwrap();
    for op in &h.secrets[..3] {
        h.work_and_share(op).await;
    }
    engine::tick(&h.app).await.unwrap();
    let (status, reveal) = h.get(&format!("/v0/reveals/{c}")).await;
    assert_eq!(status, 200, "{reveal}");
    let slots = reveal["slots"].as_array().unwrap();
    assert_eq!(slots.len(), 1);
    assert_eq!(slots[0]["is_dummy"], json!(true));
}

#[tokio::test]
async fn v0_and_v1_committees_coexist() {
    let h = harness().await;
    let mut rng = ChaCha20Rng::seed_from_u64(14);
    let (v0_params, v0_secrets) = bte_crypto::ceremony(3, 2, 4, &mut rng).unwrap();
    let v0_id = h.app.register_committee(&v0_params.to_bytes()).unwrap();
    let (_, list) = h.get("/v0/committees").await;
    let schemes: Vec<&str> = list["committees"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["scheme"].as_str().unwrap())
        .collect();
    assert!(schemes.contains(&"v0") && schemes.contains(&"v1"));

    // A v0 condition on the v0 committee still runs the v0 flow end to end.
    let (status, cond) = h
        .post(
            "/v0/conditions",
            json!({"committee_id": v0_id, "in_secs": 0}),
        )
        .await;
    assert_eq!(status, 200, "{cond}");
    let c = cond["id"].as_str().unwrap().to_string();
    let ct = bte_crypto::seal(&v0_params, b"v0 payload", &mut rng).unwrap();
    let (status, _) = h
        .post(
            "/v0/ciphertexts",
            json!({"condition_id": c, "sealed_blob_b64": B64.encode(ct.to_bytes())}),
        )
        .await;
    assert_eq!(status, 200);
    engine::tick(&h.app).await.unwrap();
    for op in &v0_secrets[..2] {
        let (_, work) = h
            .get(&format!("/v0/work?operator={}", op.party_index))
            .await;
        for batch in work["batches"].as_array().unwrap() {
            assert_eq!(batch["scheme"], json!("v0"));
            let raw = B64.decode(batch["headers_b64"].as_str().unwrap()).unwrap();
            let headers: Vec<bte_crypto::CtHeader> = raw
                .chunks(48)
                .map(|c| bte_crypto::wire::header_from_bytes(c).unwrap())
                .collect();
            let share = bte_crypto::partial(op, &headers).unwrap();
            let (status, resp) = h
                .post(
                    "/v0/shares",
                    json!({"batch_id": batch["batch_id"], "operator_id": op.party_index, "share_b64": B64.encode(share.to_bytes())}),
                )
                .await;
            assert_eq!(status, 200);
            assert_eq!(resp["verified"], json!(true), "{resp}");
        }
    }
    engine::tick(&h.app).await.unwrap();
    let (status, reveal) = h.get(&format!("/v0/reveals/{c}")).await;
    assert_eq!(status, 200, "{reveal}");
    assert_eq!(reveal["slots"].as_array().unwrap().len(), 4, "v0 pads to B");
}
