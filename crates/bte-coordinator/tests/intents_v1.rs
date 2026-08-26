//! `/v1` Private Actions integration tests.
//!
//! These exercise the endpoints through the real router and the real database,
//! because the properties worth testing here are about persistence and
//! concurrency, not about function purity: a nonce is only replay-proof if the
//! index actually rejects the second write.
//!
//! The two that matter most are `no_plaintext_before_reveal` and
//! `ordering_is_committed_before_any_share_exists`. Everything else is
//! hygiene; those two are the product.

use base64::Engine;
use bte_coordinator::{api, db, engine, intents, state};
use bte_crypto::rand::SeedableRng;
use bte_crypto::{ceremony, partial, seal, OperatorSecret, PublicParams};
use rand_chacha::ChaCha20Rng;
use serde_json::{json, Value};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
/// Deterministic throwaway test keys. Not credentials, and not derived from any
/// wallet: they exist because the coordinator now verifies EIP-712 signatures,
/// so a test that wants an intent accepted has to actually sign one.
///
/// `ATTACKER` is the whole point of the pair — it lets the tests assert that a
/// perfectly well-formed signature by the wrong key is refused, which is the
/// case that a shape-only check used to wave through.
const AGENT_KEY: [u8; 32] = [0x22; 32];

/// Ethereum Hoodi. The execution domain is bound into the EIP-712 domain
/// separator, so this is not cosmetic: a signature made for another chain does
/// not verify here.
const HOODI: u64 = 560_048;
const ATTACKER_KEY: [u8; 32] = [0x33; 32];

fn signing_key(seed: [u8; 32]) -> k256::ecdsa::SigningKey {
    k256::ecdsa::SigningKey::from_bytes(&seed.into()).expect("valid test scalar")
}

/// Sign an already-computed digest, in the 65-byte `r || s || v` form wallets
/// emit. `sign_prehash_recoverable` yields a low-s signature, so these are
/// exactly the shape the server accepts.
fn sign(seed: [u8; 32], digest: &[u8; 32]) -> String {
    let (sig, rec) = signing_key(seed)
        .sign_prehash_recoverable(digest)
        .expect("signable digest");
    let mut out = sig.to_bytes().to_vec();
    out.push(27 + rec.to_byte());
    format!("0x{}", hex::encode(out))
}

/// The address a key signs as, learned by round-tripping through the same
/// recovery the server uses rather than re-deriving it here. A second
/// implementation of address derivation in the tests could agree with itself
/// and disagree with production.
fn address_of(seed: [u8; 32]) -> String {
    let digest = [0x01u8; 32];
    bte_coordinator::eip712::recover(&digest, &sign(seed, &digest)).expect("recoverable")
}

/// Re-sign an envelope, so a test that mutates a field is testing that field's
/// validation rather than tripping over a stale signature.
///
/// This shares `intent_digest` with production, so it does not independently
/// prove the digest is correct — `eip712::tests::digest_matches_viem` pins that
/// against a vector produced by viem. What these tests prove is the wiring:
/// that the endpoints verify at all, and against the right address.
fn resign(b: &mut Value, seed: [u8; 32]) {
    if let Some(d) = bte_coordinator::eip712::intent_digest(
        b["protocol_version"].as_u64().unwrap_or(0) as u16,
        b["intent_id"].as_str().unwrap_or(""),
        b["encryption_key_id"].as_str().unwrap_or(""),
        b["ciphertext_hash"].as_str().unwrap_or(""),
        b["nonce"].as_str().unwrap_or(""),
        b["expires_at"].as_i64().unwrap_or(0),
        b["execution_domain"].as_u64().unwrap_or(0),
    ) {
        b["signature"] = json!(sign(seed, &d));
    }
}

struct H {
    app: state::App,
    base: String,
    client: reqwest::Client,
    params: PublicParams,
    secrets: Vec<OperatorSecret>,
    committee_id: String,
}

async fn harness() -> H {
    let mut rng = ChaCha20Rng::seed_from_u64(11);
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
    H {
        app,
        base,
        client: reqwest::Client::new(),
        params,
        secrets,
        committee_id,
    }
}

impl H {
    async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        let r = self
            .client
            .post(format!("{}{path}", self.base))
            .json(&body)
            .send()
            .await
            .unwrap();
        let s = r.status().as_u16();
        (s, r.json().await.unwrap_or(Value::Null))
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let r = self
            .client
            .get(format!("{}{path}", self.base))
            .send()
            .await
            .unwrap();
        let s = r.status().as_u16();
        (s, r.json().await.unwrap_or(Value::Null))
    }

    /// Create a condition and seal one payload into it, returning
    /// (condition_id, ct_hash).
    async fn sealed(&self, payload: &[u8], in_secs: i64) -> (String, String) {
        let (st, cond) = self
            .post(
                "/v0/conditions",
                json!({"committee_id": self.committee_id, "in_secs": in_secs}),
            )
            .await;
        assert_eq!(st, 200, "{cond}");
        let condition_id = cond["id"].as_str().unwrap().to_string();

        let mut rng = bte_crypto::os_rng();
        let ct = seal(&self.params, payload, &mut rng).unwrap();
        let (st, resp) = self
            .post(
                "/v0/ciphertexts",
                json!({"condition_id": condition_id, "sealed_blob_b64": B64.encode(ct.to_bytes())}),
            )
            .await;
        assert_eq!(st, 200, "{resp}");
        (condition_id, resp["ct_hash"].as_str().unwrap().to_string())
    }

    async fn work_and_share(&self, s: &OperatorSecret) {
        let (_, work) = self
            .get(&format!("/v0/work?operator={}", s.party_index))
            .await;
        for item in work["batches"].as_array().cloned().unwrap_or_default() {
            let batch_id = item["batch_id"].as_i64().unwrap();
            // headers_b64 is one base64 blob of concatenated 48-byte KEM
            // headers, not an array.
            let raw = B64.decode(item["headers_b64"].as_str().unwrap()).unwrap();
            let headers: Vec<bte_crypto::CtHeader> = raw
                .chunks(48)
                .map(|c| bte_crypto::wire::header_from_bytes(c).unwrap())
                .collect();
            let share = partial(s, &headers).unwrap();
            self.post(
                "/v0/shares",
                json!({"batch_id": batch_id, "operator_id": s.party_index,
                       "share_b64": B64.encode(share.to_bytes())}),
            )
            .await;
        }
    }
}

fn envelope(condition_id: &str, ct_hash: &str, nonce: &str) -> Value {
    let mut b = json!({
        "protocol_version": 1,
        "intent_id": format!("intent_{nonce}"),
        "encryption_key_id": "a".repeat(64),
        "ciphertext_hash": ct_hash,
        "nonce": nonce,
        "created_at": db::unix_now(),
        "expires_at": db::unix_now() + 600,
        "pseudonymous_signer": address_of(AGENT_KEY),
        "execution_domain": HOODI,
        "signature": "0x00",
        "condition_id": condition_id,
    });
    resign(&mut b, AGENT_KEY);
    b
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn submit_and_read_back_an_intent() {
    let h = harness().await;
    let (cond, ct) = h.sealed(b"swap payload", 60).await;
    let (st, r) = h
        .post("/v1/intents", envelope(&cond, &ct, "nonce_00000001"))
        .await;
    assert_eq!(st, 200, "{r}");
    assert_eq!(r["state"], "SUBMITTED");
    assert_eq!(r["duplicate"], false);

    let (st, got) = h.get("/v1/intents/intent_nonce_00000001").await;
    assert_eq!(st, 200, "{got}");
    assert_eq!(got["ciphertextHash"], ct);
    assert_eq!(got["state"], "SUBMITTED");
    assert_eq!(got["executionDomain"], HOODI);
}

/// Invariant: the coordinator cannot serve intent contents early, because it
/// never has them. This walks the whole flow and greps every pre-reveal
/// response for the plaintext.
#[tokio::test]
async fn no_plaintext_before_reveal() {
    let h = harness().await;
    let secret = b"SELL 50000 USDC FOR ETH AT 4200";
    let (cond, ct) = h.sealed(secret, 0).await;
    let (st, _) = h
        .post("/v1/intents", envelope(&cond, &ct, "nonce_secret001"))
        .await;
    assert_eq!(st, 200);

    let needle = String::from_utf8_lossy(secret).to_string();
    for path in [
        "/v1/intents/intent_nonce_secret001",
        "/v1/intents/intent_nonce_secret001/events",
        &format!("/v0/conditions/{cond}"),
    ] {
        let (_, body) = h.get(path).await;
        let text = body.to_string();
        assert!(
            !text.contains(&needle),
            "plaintext leaked from {path}: {text}"
        );
    }

    // Freeze and commit ordering — still nothing readable.
    engine::tick(&h.app).await.unwrap();
    let (_, body) = h.get("/v1/intents/intent_nonce_secret001").await;
    assert_eq!(body["state"], "ORDER_COMMITTED");
    assert!(!body.to_string().contains(&needle));

    // And the reveal endpoint 404s until the threshold is met.
    let (st, _) = h.get(&format!("/v0/reveals/{cond}")).await;
    assert_eq!(st, 404, "reveal must not exist before the threshold");
}

/// The commitment must exist before any operator has posted a share. If it did
/// not, an executor could read a batch and only then decide what order to claim.
#[tokio::test]
async fn ordering_is_committed_before_any_share_exists() {
    let h = harness().await;
    let (cond, ct) = h.sealed(b"payload", 0).await;
    h.post("/v1/intents", envelope(&cond, &ct, "nonce_order0001"))
        .await;

    engine::tick(&h.app).await.unwrap();

    // A commitment exists for the batch...
    let (st, c) = h.get("/v1/batches/1/commitment").await;
    assert_eq!(st, 200, "{c}");
    assert_eq!(c["batchSize"], 4);
    assert!(c["orderingRoot"].as_str().unwrap().len() == 64);
    let committed_at = c["committedAt"].as_i64().unwrap();

    // ...and at this point not one share has been submitted.
    let shares: i64 = {
        let conn = h.app.0.db.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM shares", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(
        shares, 0,
        "ordering must be committed before any share exists"
    );

    // Drive to reveal, then check the ordering the receipt would rely on.
    for s in &h.secrets {
        h.work_and_share(s).await;
    }
    engine::tick(&h.app).await.unwrap();
    let (st, reveal) = h.get(&format!("/v0/reveals/{cond}")).await;
    assert_eq!(st, 200, "{reveal}");

    let revealed_at: i64 = {
        let conn = h.app.0.db.lock().unwrap();
        conn.query_row(
            "SELECT revealed_at FROM reveals WHERE condition_id = ?1",
            [&cond],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert!(
        committed_at <= revealed_at,
        "commitment {committed_at} must not postdate reveal {revealed_at}"
    );
}

#[tokio::test]
async fn the_ordering_root_is_reproducible_and_position_bound() {
    // Same inputs, same root. The root is what an inclusion proof is checked
    // against, so a coordinator that could not reproduce it could not be audited.
    let h = harness().await;
    let (cond, ct) = h.sealed(b"payload", 0).await;
    h.post("/v1/intents", envelope(&cond, &ct, "nonce_repro0001"))
        .await;
    engine::tick(&h.app).await.unwrap();

    let (_, c) = h.get("/v1/batches/1/commitment").await;
    let root = c["orderingRoot"].as_str().unwrap().to_string();

    // Recompute from the stored slots exactly as an auditor would.
    let conn = h.app.0.db.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT ct_hash FROM ciphertexts WHERE condition_id = ?1 ORDER BY position ASC")
        .unwrap();
    let hashes: Vec<String> = stmt
        .query_map([&cond], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let leaves: Vec<[u8; 32]> = hashes
        .iter()
        .map(|hsh| {
            let intent_id: String = conn
                .query_row(
                    "SELECT id FROM intents WHERE ciphertext_hash = ?1",
                    [hsh],
                    |r| r.get(0),
                )
                .unwrap_or_default();
            bte_coordinator::merkle::ordering_leaf(&intent_id, &hex::decode(hsh).unwrap())
        })
        .collect();
    assert_eq!(hex::encode(bte_coordinator::merkle::root(&leaves)), root);

    // Swapping two positions changes the root, which is the whole point.
    let mut swapped = leaves.clone();
    swapped.swap(0, 1);
    assert_ne!(hex::encode(bte_coordinator::merkle::root(&swapped)), root);
}

#[tokio::test]
async fn a_replayed_nonce_is_refused() {
    let h = harness().await;
    let (cond, ct) = h.sealed(b"one", 60).await;
    let (st, _) = h
        .post("/v1/intents", envelope(&cond, &ct, "nonce_replay001"))
        .await;
    assert_eq!(st, 200);

    // Same signer, same nonce, different intent id: still a replay.
    //
    // Re-signed, because the agent owns the key and could legitimately produce
    // this envelope — the point is that the nonce index refuses it anyway, not
    // that the signature check happens to catch it.
    let mut second = envelope(&cond, &ct, "nonce_replay001");
    second["intent_id"] = json!("intent_different");
    resign(&mut second, AGENT_KEY);
    let (st, r) = h.post("/v1/intents", second).await;
    assert_eq!(st, 409, "{r}");
    assert_eq!(r["error"]["code"], "REPLAY");
}

#[tokio::test]
async fn an_idempotent_submission_returns_the_original() {
    let h = harness().await;
    let (cond, ct) = h.sealed(b"idem", 60).await;
    let mut body = envelope(&cond, &ct, "nonce_idem00001");
    body["idempotency_key"] = json!("key-1");

    let (st, first) = h.post("/v1/intents", body.clone()).await;
    assert_eq!(st, 200);
    assert_eq!(first["duplicate"], false);

    // Replaying the exact call must return the original answer, not a conflict:
    // a client that retried on a dropped connection has done nothing wrong.
    let (st, again) = h.post("/v1/intents", body).await;
    assert_eq!(st, 200, "{again}");
    assert_eq!(again["duplicate"], true);
    assert_eq!(again["intent_id"], first["intent_id"]);

    let count: i64 = {
        let conn = h.app.0.db.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM intents", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(count, 1, "an idempotent retry must not create a second row");
}

#[tokio::test]
async fn malformed_envelopes_are_refused_with_stable_codes() {
    let h = harness().await;
    let (cond, ct) = h.sealed(b"bad", 60).await;

    let cases: Vec<(&str, Value, &str)> = vec![("expired", json!(db::unix_now() - 1), "EXPIRED")];
    for (name, v, code) in cases {
        let mut b = envelope(&cond, &ct, "nonce_bad000001");
        b["expires_at"] = v;
        let (st, r) = h.post("/v1/intents", b).await;
        assert_eq!(st, 400, "{name}: {r}");
        assert_eq!(r["error"]["code"], code, "{name}");
    }

    for (field, value, code) in [
        ("ciphertext_hash", json!("nope"), "BAD_CIPHERTEXT_HASH"),
        ("encryption_key_id", json!("nope"), "BAD_KEY_ID"),
        ("pseudonymous_signer", json!("0x1234"), "BAD_SIGNER"),
        ("nonce", json!("!!"), "BAD_NONCE"),
        ("intent_id", json!("x"), "BAD_INTENT_ID"),
        ("protocol_version", json!(2), "UNSUPPORTED_VERSION"),
        ("execution_domain", json!(0), "BAD_DOMAIN"),
        ("signature", json!("not-hex"), "BAD_SIGNATURE"),
    ] {
        let mut b = envelope(&cond, &ct, "nonce_bad000002");
        b[field] = value;
        let (st, r) = h.post("/v1/intents", b).await;
        assert_eq!(st, 400, "{field}: {r}");
        assert_eq!(r["error"]["code"], code, "{field}");
    }
}

#[tokio::test]
async fn an_intent_cannot_point_at_a_ciphertext_that_does_not_exist() {
    let h = harness().await;
    let (cond, _) = h.sealed(b"real", 60).await;
    let mut b = envelope(&cond, &"f".repeat(64), "nonce_ghost0001");
    b["ciphertext_hash"] = json!("f".repeat(64));
    let (st, r) = h.post("/v1/intents", b).await;
    assert_eq!(st, 400, "{r}");
    assert_eq!(r["error"]["code"], "UNKNOWN_CIPHERTEXT");
}

#[tokio::test]
async fn an_intent_cannot_join_a_condition_that_already_froze() {
    // After freeze the ordering is fixed. Letting an intent attach afterwards
    // would have it claim a position it was never in.
    let h = harness().await;
    let (cond, ct) = h.sealed(b"late", 0).await;
    engine::tick(&h.app).await.unwrap();

    let (st, r) = h
        .post("/v1/intents", envelope(&cond, &ct, "nonce_late00001"))
        .await;
    assert_eq!(st, 409, "{r}");
    assert_eq!(r["error"]["code"], "CONDITION_CLOSED");
}

#[tokio::test]
async fn the_lifecycle_is_recorded_as_an_audit_trail() {
    let h = harness().await;
    let (cond, ct) = h.sealed(b"trail", 0).await;
    h.post("/v1/intents", envelope(&cond, &ct, "nonce_trail0001"))
        .await;
    engine::tick(&h.app).await.unwrap();

    let (st, ev) = h.get("/v1/intents/intent_nonce_trail0001/events").await;
    assert_eq!(st, 200, "{ev}");
    let events = ev["events"].as_array().unwrap();
    let path: Vec<&str> = events.iter().map(|e| e["to"].as_str().unwrap()).collect();
    assert_eq!(
        path,
        vec!["SUBMITTED", "VALIDATED", "BATCHED", "ORDER_COMMITTED"],
        "every state must be recorded, none skipped"
    );
    // Contiguous: each event starts where the last one ended.
    for w in events.windows(2) {
        assert_eq!(w[0]["to"], w[1]["from"]);
    }
}

#[tokio::test]
async fn authorization_is_refused_from_an_illegal_state() {
    let h = harness().await;
    let (cond, ct) = h.sealed(b"auth", 60).await;
    h.post("/v1/intents", envelope(&cond, &ct, "nonce_auth00001"))
        .await;

    // Correctly signed by the intent's own agent, so the refusal below is the
    // state machine talking and not the signature check.
    let auth = [0xb1u8; 32];
    let (st, r) = h
        .post(
            "/v1/intents/intent_nonce_auth00001/authorization",
            json!({"authorization_hash": hex::encode(auth),
                   "signature": sign(AGENT_KEY, &auth),
                   "submission_mode": "private"}),
        )
        .await;
    // SUBMITTED -> AUTHORIZED would skip ordering, reveal, and quote validation.
    assert_eq!(st, 409, "{r}");
    assert_eq!(r["error"]["code"], "ILLEGAL_TRANSITION");
}

/// The hole this whole change closes, stated as a test.
///
/// An envelope naming somebody else's address, signed perfectly well by a key
/// that is not theirs, must be refused. Before server-side verification this
/// was accepted, and every downstream artifact — the replay index, the ordering
/// commitment, the receipt — attributed the intent to the impersonated address.
#[tokio::test]
async fn an_intent_cannot_be_submitted_on_someone_elses_behalf() {
    let h = harness().await;
    let (cond, ct) = h.sealed(b"impersonation", 60).await;

    let victim = address_of(AGENT_KEY);
    let mut b = envelope(&cond, &ct, "nonce_forged001");
    // Keep the claimed signer; swap in a valid signature from the wrong key.
    resign(&mut b, ATTACKER_KEY);
    assert_eq!(b["pseudonymous_signer"], json!(victim));

    let (st, r) = h.post("/v1/intents", b).await;
    assert_eq!(st, 400, "forged envelope was accepted: {r}");
    assert_eq!(r["error"]["code"], "BAD_SIGNATURE");

    // And the impersonated address has nothing attributed to it.
    let (st, _) = h.get("/v1/intents/intent_nonce_forged001").await;
    assert_eq!(st, 404);
}

/// The same hole on the authorization endpoint, which was the worse of the two:
/// the caller supplies the digest, so an unauthenticated authorization let
/// anyone who learned an intent id bind that intent to a quote of their own
/// choosing.
#[tokio::test]
async fn an_intent_cannot_be_authorized_by_a_stranger() {
    let h = harness().await;
    let (cond, ct) = h.sealed(b"stranger", 60).await;
    let (st, _) = h
        .post("/v1/intents", envelope(&cond, &ct, "nonce_strange01"))
        .await;
    assert_eq!(st, 200);

    let auth = [0xc2u8; 32];
    let (st, r) = h
        .post(
            "/v1/intents/intent_nonce_strange01/authorization",
            json!({"authorization_hash": hex::encode(auth),
                   "signature": sign(ATTACKER_KEY, &auth),
                   "submission_mode": "private"}),
        )
        .await;
    assert_eq!(st, 400, "a stranger authorized someone else's intent: {r}");
    assert_eq!(r["error"]["code"], "BAD_SIGNATURE");
}

/// A signature over a different digest than the one submitted is refused, so an
/// authorization cannot be lifted off one request and replayed onto another.
#[tokio::test]
async fn an_authorization_signature_is_bound_to_its_hash() {
    let h = harness().await;
    let (cond, ct) = h.sealed(b"rebind", 60).await;
    h.post("/v1/intents", envelope(&cond, &ct, "nonce_rebind001"))
        .await;

    let signed = [0xd3u8; 32];
    let submitted = [0xd4u8; 32];
    let (st, r) = h
        .post(
            "/v1/intents/intent_nonce_rebind001/authorization",
            json!({"authorization_hash": hex::encode(submitted),
                   "signature": sign(AGENT_KEY, &signed),
                   "submission_mode": "private"}),
        )
        .await;
    assert_eq!(st, 400, "{r}");
    assert_eq!(r["error"]["code"], "BAD_SIGNATURE");
}

#[tokio::test]
async fn authorization_validates_its_own_fields() {
    let h = harness().await;
    let (cond, ct) = h.sealed(b"authf", 60).await;
    h.post("/v1/intents", envelope(&cond, &ct, "nonce_authf0001"))
        .await;
    let p = "/v1/intents/intent_nonce_authf0001/authorization";

    for (body, code) in [
        (
            json!({"authorization_hash": "nope", "signature": "0xab", "submission_mode": "private"}),
            "BAD_AUTH_HASH",
        ),
        (
            json!({"authorization_hash": "b".repeat(64), "signature": "nope", "submission_mode": "private"}),
            "BAD_SIGNATURE",
        ),
        (
            json!({"authorization_hash": "b".repeat(64), "signature": "0xab", "submission_mode": "carrier-pigeon"}),
            "BAD_SUBMISSION_MODE",
        ),
    ] {
        let (st, r) = h.post(p, body).await;
        assert_eq!(st, 400, "{r}");
        assert_eq!(r["error"]["code"], code);
    }
}

#[tokio::test]
async fn unknown_things_are_404_not_500() {
    let h = harness().await;
    for path in [
        "/v1/intents/intent_does_not_exist",
        "/v1/intents/intent_does_not_exist/events",
        "/v1/batches/999/commitment",
    ] {
        let (st, r) = h.get(path).await;
        assert_eq!(st, 404, "{path}: {r}");
        assert!(r["error"]["code"].is_string());
    }
}

/// The Rust and TypeScript lifecycle graphs are hand-mirrored, so this pins the
/// Rust side. `packages/actions/test/state.test.ts` pins the other, and the two
/// lists are compared in CI by eye when either changes.
#[tokio::test]
async fn the_lifecycle_graph_matches_the_client() {
    // QUOTING is unreachable without ORDER_COMMITTED and REVEALED. Proven the
    // same way as in state.test.ts: every simple path from DRAFT.
    fn paths_to(target: &str) -> Vec<Vec<String>> {
        let mut out = Vec::new();
        fn walk(at: &str, target: &str, seen: &mut Vec<String>, out: &mut Vec<Vec<String>>) {
            if at == target {
                let mut p = seen.clone();
                p.push(at.to_string());
                out.push(p);
                return;
            }
            for nxt in intents::next_states(at) {
                if seen.iter().any(|s| s == nxt) {
                    continue;
                }
                seen.push(at.to_string());
                walk(nxt, target, seen, out);
                seen.pop();
            }
        }
        walk("DRAFT", target, &mut Vec::new(), &mut out);
        out
    }

    let paths = paths_to("QUOTING");
    assert!(!paths.is_empty());
    for p in &paths {
        let oc = p.iter().position(|s| s == "ORDER_COMMITTED");
        let rv = p.iter().position(|s| s == "REVEALED");
        let q = p.iter().position(|s| s == "QUOTING");
        assert!(oc.is_some(), "path skipped ORDER_COMMITTED: {p:?}");
        assert!(rv.is_some(), "path skipped REVEALED: {p:?}");
        assert!(oc < rv && rv < q, "wrong order in {p:?}");
    }

    // Terminal states are terminal on this side too.
    for s in ["SETTLED", "FAILED", "EXPIRED", "CANCELLED"] {
        assert!(intents::next_states(s).is_empty(), "{s} is not terminal");
    }
    // Cancellation is impossible once the batch owns the intent.
    for s in [
        "BATCHED",
        "ORDER_COMMITTED",
        "COLLECTING_SHARES",
        "THRESHOLD_REACHED",
    ] {
        assert!(
            !intents::can_transition(s, "CANCELLED"),
            "{s} must not cancel"
        );
    }
    assert_eq!(intents::STATES.len(), 19);
}
