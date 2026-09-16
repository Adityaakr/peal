//! Gate A: a genuine send and claim, plus invalid operations rejected, on
//! the persistent ledger, replayable after reopening.
//!
//! Everything here runs the pinned upstream prover and verifier. There is
//! no test double: a wallet that cannot make a valid proof cannot move
//! funds, and the ledger's only acceptance path is `ZkPari::verify`.

use peal_bonsai::account::{namespace_id, OpEnvelope, SpendKey};
use peal_bonsai::deposit::MintEnvelope;
use peal_bonsai::encoding::proof_to_bytes;
use peal_bonsai::ledger::{Ledger, LedgerConfig, VerifyingKeys};
use peal_bonsai::params::{constraint_profile, Instance, Keys};
use peal_bonsai::wallet::{ReceiptStatus, ReceiptWitness, Reconciled, Wallet};
use peal_bonsai::{Error, Fr};
use std::sync::OnceLock;
use zkpari::ZkPari;

struct Fixture {
    inst: Instance,
    keys: Keys,
    dir: tempfile::TempDir,
}

/// Keygen once per test binary (a couple of seconds at this depth).
fn fixture() -> &'static Fixture {
    static F: OnceLock<Fixture> = OnceLock::new();
    F.get_or_init(|| {
        let inst = Instance::default_instance();
        let dir = tempfile::tempdir().unwrap();
        let t = std::time::Instant::now();
        let keys = Keys::load_or_generate(&inst, &dir.path().join("params")).unwrap();
        eprintln!("keygen: {:?}", t.elapsed());
        // Keys round-trip through disk with the same circuit id.
        let reloaded = Keys::load(&inst, &dir.path().join("params")).unwrap();
        assert_eq!(reloaded.circuit_id, keys.circuit_id);
        assert_eq!(reloaded.op.vk_digest, keys.op.vk_digest);
        Fixture { inst, keys, dir }
    })
}

fn config(f: &Fixture, label: &str) -> LedgerConfig {
    LedgerConfig {
        namespace: namespace_id(label),
        circuit_id: f.keys.circuit_id,
        root_window: 8,
    }
}

fn open(f: &Fixture, path: &std::path::Path, label: &str) -> Ledger {
    Ledger::open(
        path,
        f.inst.clone(),
        VerifyingKeys::from(&f.keys),
        config(f, label),
    )
    .unwrap()
}

fn mint(
    f: &Fixture,
    ledger: &mut Ledger,
    wallet: &mut Wallet,
    amount: u64,
    deposit_id: &str,
) -> u64 {
    let mut rng = peal_bonsai::os_rng();
    let (intent, _opening) = wallet
        .prepare_deposit(&f.inst, &f.keys, amount, None, 1, &mut rng)
        .unwrap();
    let applied = ledger
        .mint(&MintEnvelope {
            intent: intent.clone(),
            deposit_id: deposit_id.to_string(),
        })
        .unwrap();
    // Duplicate event identity is refused.
    assert!(matches!(
        ledger.mint(&MintEnvelope {
            intent,
            deposit_id: deposit_id.to_string()
        }),
        Err(Error::Storage(_))
    ));
    let idx = wallet
        .deposit_minted(
            &f.inst,
            ledger.receipt_tree().leaf(applied.position).unwrap(),
            applied.position,
            1,
        )
        .unwrap();
    let witness = ReceiptWitness {
        path: ledger.receipt_tree().path(applied.position).unwrap(),
        root: ledger.receipt_root(),
    };
    assert!(wallet.verify_receipt(&f.inst, idx, &witness).unwrap());
    applied.position
}

/// Claim held receipt `idx` end to end: prepare, prove, apply, commit.
fn claim(f: &Fixture, ledger: &mut Ledger, wallet: &mut Wallet, idx: usize) -> u64 {
    let mut rng = peal_bonsai::os_rng();
    let position = wallet.receipts[idx].position;
    let witness = ReceiptWitness {
        path: ledger.receipt_tree().path(position).unwrap(),
        root: ledger.receipt_root(),
    };
    let circuit = wallet
        .prepare_receive(&f.inst, idx, &witness, 2, &mut rng)
        .unwrap();
    let t = std::time::Instant::now();
    let env = wallet.prove_pending(&f.keys, circuit, &mut rng).unwrap();
    eprintln!("receive proof: {:?}", t.elapsed());
    let applied = ledger.apply(&env).unwrap();
    wallet.commit_pending(applied.position, 2).unwrap();
    assert_eq!(
        ledger.account(&wallet.account).unwrap().unwrap().com,
        wallet.commitment(&f.inst)
    );
    applied.position
}

#[test]
fn constraint_profile_fits_the_expected_domain() {
    let inst = Instance::default_instance();
    let (n, domain) = constraint_profile(&inst);
    eprintln!("R_op: {n} SR1CS constraints, domain {domain}");
    assert!(domain <= 1 << 17, "circuit grew past the budgeted domain");
}

#[test]
fn send_and_claim_on_a_persistent_ledger_with_invalid_operations_rejected() {
    let f = fixture();
    let db = f.dir.path().join("ledger-a.sqlite");
    let ns = namespace_id("test/ns-a");
    let mut rng = peal_bonsai::os_rng();
    let mut ledger = open(f, &db, "test/ns-a");
    let genesis_root = ledger.state_root();

    let mut alice = Wallet::create(&f.inst, f.keys.circuit_id, ns, &mut rng);
    let mut bob = Wallet::create(&f.inst, f.keys.circuit_id, ns, &mut rng);
    for w in [&mut alice, &mut bob] {
        let env = w.register_envelope().unwrap();
        ledger.register(&env).unwrap();
        assert_eq!(ledger.register(&env), Err(Error::AccountExists));
        w.registered = true;
        assert_eq!(
            ledger.account(&w.account).unwrap().unwrap().com,
            w.commitment(&f.inst)
        );
    }
    assert_ne!(
        ledger.state_root(),
        genesis_root,
        "registration moves the state root"
    );

    // Alice funds her account: a mint receipt she then claims.
    mint(f, &mut ledger, &mut alice, 1_000_000, "31337:0xabc:0");
    assert_eq!(alice.balances(), (0, 1_000_000));
    claim(f, &mut ledger, &mut alice, 0);
    assert_eq!(alice.balances(), (1_000_000, 0));

    // A stale wallet snapshot (before the claim) racing from the same old
    // commitment: the proof verifies as a proof, the ledger rejects it as
    // stale because the account moved. That is the STF, not the API.
    let mut stale = Wallet::from_json(&alice.to_json()).unwrap();
    stale.balance = 0;
    stale.randomness = alice.randomness; // wrong: alice already rotated

    // Alice sends 250_000 to Bob.
    let root = ledger.receipt_root();
    let circuit = alice
        .prepare_send(
            &f.inst,
            250_000,
            bob.account,
            root,
            Some("req-1".into()),
            3,
            &mut rng,
        )
        .unwrap();
    let t = std::time::Instant::now();
    let send_env = alice.prove_pending(&f.keys, circuit, &mut rng).unwrap();
    eprintln!("send proof: {:?}", t.elapsed());

    // Tampering before it lands: a flipped proof byte, a redirected
    // receipt, a foreign namespace, a wrong root.
    {
        let mut bad = send_env.clone();
        bad.proof[10] ^= 1;
        let err = ledger.apply(&bad).unwrap_err();
        assert!(
            matches!(err, Error::BadSignature),
            "tampered bytes fail the envelope signature first: {err:?}"
        );
        let resigned = OpEnvelope::sign(
            &alice.spend_key(),
            bad.namespace,
            bad.circuit_id,
            bad.account,
            bad.com,
            bad.com_new,
            bad.receipt,
            bad.root,
            bad.proof.clone(),
        );
        let err = ledger.apply(&resigned).unwrap_err();
        assert!(
            matches!(err, Error::InvalidPoint | Error::InvalidProof),
            "{err:?}"
        );

        let redirected = OpEnvelope::sign(
            &alice.spend_key(),
            send_env.namespace,
            send_env.circuit_id,
            send_env.account,
            send_env.com,
            send_env.com_new,
            send_env.receipt + Fr::from(1u64),
            send_env.root,
            send_env.proof.clone(),
        );
        assert_eq!(ledger.apply(&redirected), Err(Error::InvalidProof));

        let foreign = OpEnvelope::sign(
            &alice.spend_key(),
            namespace_id("test/other"),
            send_env.circuit_id,
            send_env.account,
            send_env.com,
            send_env.com_new,
            send_env.receipt,
            send_env.root,
            send_env.proof.clone(),
        );
        assert_eq!(ledger.apply(&foreign), Err(Error::WrongNamespace));

        let wrong_root = OpEnvelope::sign(
            &alice.spend_key(),
            send_env.namespace,
            send_env.circuit_id,
            send_env.account,
            send_env.com,
            send_env.com_new,
            send_env.receipt,
            Fr::from(12345u64),
            send_env.proof.clone(),
        );
        assert_eq!(ledger.apply(&wrong_root), Err(Error::RootNotRecent));

        // An unregistered account with a valid signature is unknown.
        let stranger = SpendKey::generate(&mut rng);
        let unknown = OpEnvelope::sign(
            &stranger,
            send_env.namespace,
            send_env.circuit_id,
            stranger.account_id(&ns),
            send_env.com,
            send_env.com_new,
            send_env.receipt,
            send_env.root,
            send_env.proof.clone(),
        );
        assert_eq!(ledger.apply(&unknown), Err(Error::UnknownAccount));
    }
    let state_before = ledger.state_root();
    let applied = ledger.apply(&send_env).unwrap();
    assert_ne!(ledger.state_root(), state_before);
    // Same envelope again: the account moved, so its proof is stale.
    assert_eq!(ledger.apply(&send_env), Err(Error::StaleCommitment));
    alice.commit_pending(applied.position, 3).unwrap();
    assert_eq!(alice.balances(), (750_000, 0));

    // The stale snapshot cannot spend the pre-send state either: its
    // commitment is not the account's current one.
    let stale_circuit = stale.prepare_send(
        &f.inst,
        1,
        bob.account,
        ledger.receipt_root(),
        None,
        3,
        &mut rng,
    );
    assert!(
        stale_circuit.is_err(),
        "stale wallet has no balance to spend"
    );

    // Bob receives the opening out of band (the SDK encrypts it), verifies
    // it against the ledger, and claims.
    let (opening, position) =
        send_with_delivery(f, &mut ledger, &mut alice, &mut bob, 100_000, "req-2");
    let idx = bob.add_receipt(&f.inst, position, opening.clone(), Some("req-2".into()), 4);
    // Bob was offline: the log has grown since; the served path is against
    // the current root, which is within the window.
    let witness = ReceiptWitness {
        path: ledger.receipt_tree().path(position).unwrap(),
        root: ledger.receipt_root(),
    };
    assert!(bob.verify_receipt(&f.inst, idx, &witness).unwrap());
    assert_eq!(bob.balances(), (0, 100_000));
    claim(f, &mut ledger, &mut bob, idx);
    assert_eq!(bob.balances(), (100_000, 0));
    assert_eq!(bob.receipts[idx].status, ReceiptStatus::Claimed);
    // Double claim: the wallet refuses (position already in its set) and a
    // forced attempt from a pre-claim snapshot is stale at the ledger.
    assert!(bob
        .prepare_receive(&f.inst, idx, &witness, 5, &mut rng)
        .is_err());

    // Wrong recipient: Alice cannot claim Bob's receipt.
    {
        let mut thief = Wallet::from_json(&alice.to_json()).unwrap();
        let i = thief.add_receipt(&f.inst, position, opening.clone(), None, 4);
        assert!(!thief.verify_receipt(&f.inst, i, &witness).unwrap());
        assert!(thief
            .prepare_receive(&f.inst, i, &witness, 5, &mut rng)
            .is_err());
    }

    // Overdraft is unwitnessable: forcing the circuit past the balance
    // fails at proving time, never reaching the ledger.
    {
        let mut greedy = Wallet::from_json(&alice.to_json()).unwrap();
        greedy.balance += 1; // lie locally
        let circuit = greedy
            .prepare_send(
                &f.inst,
                greedy.balance,
                bob.account,
                ledger.receipt_root(),
                None,
                6,
                &mut rng,
            )
            .unwrap();
        // The commitment the circuit opens is not the account's: rejected
        // as stale before any pairing, and, with the claimed old commitment
        // forged to the real one, as an invalid proof.
        let env = greedy.prove_pending(&f.keys, circuit, &mut rng).unwrap();
        assert_eq!(ledger.apply(&env), Err(Error::StaleCommitment));
        let forged = OpEnvelope::sign(
            &greedy.spend_key(),
            env.namespace,
            env.circuit_id,
            env.account,
            alice.commitment(&f.inst),
            env.com_new,
            env.receipt,
            env.root,
            env.proof.clone(),
        );
        assert_eq!(ledger.apply(&forged), Err(Error::InvalidProof));
        greedy.abort_pending();
    }

    // Persistence: reopen, same state root, replay re-verifies every proof,
    // and the ledger keeps working.
    let root_before = ledger.state_root();
    let seq_before = ledger.seq();
    let receipts_before = ledger.receipt_count();
    drop(ledger);
    let mut ledger = open(f, &db, "test/ns-a");
    assert_eq!(ledger.state_root(), root_before);
    assert_eq!(ledger.seq(), seq_before);
    assert_eq!(ledger.receipt_count(), receipts_before);
    assert_eq!(ledger.verify_replay().unwrap(), root_before);
    assert_eq!(ledger.minted_total().unwrap(), 1_000_000);
    // A store bound to another namespace refuses to open.
    assert!(Ledger::open(
        &db,
        f.inst.clone(),
        VerifyingKeys::from(&f.keys),
        config(f, "test/other")
    )
    .is_err());

    // Crash recovery in the wallet: Alice proves and submits, then "loses"
    // the response; reconcile from the ledger's commitment alone.
    let root = ledger.receipt_root();
    let circuit = alice
        .prepare_send(&f.inst, 1_000, bob.account, root, None, 7, &mut rng)
        .unwrap();
    let env = alice.prove_pending(&f.keys, circuit, &mut rng).unwrap();
    let snapshot = alice.to_json(); // persisted before submission
    let applied = ledger.apply(&env).unwrap();
    let mut recovered = Wallet::from_json(&snapshot).unwrap();
    let com = ledger.account(&recovered.account).unwrap().unwrap().com;
    assert_eq!(
        recovered
            .reconcile(&f.inst, com, Some(applied.position), 8)
            .unwrap(),
        Reconciled::Committed
    );
    assert_eq!(recovered.balance, 649_000);
    // And a submission that never landed is aborted on reconcile.
    let mut lost = Wallet::from_json(&recovered.to_json()).unwrap();
    let _ = lost
        .prepare_send(
            &f.inst,
            5,
            bob.account,
            ledger.receipt_root(),
            None,
            9,
            &mut rng,
        )
        .unwrap();
    let com = ledger.account(&lost.account).unwrap().unwrap().com;
    assert_eq!(
        lost.reconcile(&f.inst, com, None, 9).unwrap(),
        Reconciled::Aborted
    );
    assert_eq!(lost.balance, 649_000);
}

/// Alice sends `amount` to Bob and hands back the opening the SDK would
/// encrypt for delivery, plus the receipt position.
fn send_with_delivery(
    f: &Fixture,
    ledger: &mut Ledger,
    alice: &mut Wallet,
    bob: &mut Wallet,
    amount: u64,
    reference: &str,
) -> (peal_bonsai::trees::ReceiptOpening, u64) {
    let mut rng = peal_bonsai::os_rng();
    let root = ledger.receipt_root();
    let circuit = alice
        .prepare_send(
            &f.inst,
            amount,
            bob.account,
            root,
            Some(reference.into()),
            3,
            &mut rng,
        )
        .unwrap();
    let opening = match &alice.pending.as_ref().unwrap().kind {
        peal_bonsai::wallet::PendingKind::Send { opening, .. } => opening.clone(),
        _ => unreachable!(),
    };
    let env = alice.prove_pending(&f.keys, circuit, &mut rng).unwrap();
    let applied = ledger.apply(&env).unwrap();
    alice.commit_pending(applied.position, 3).unwrap();
    assert_eq!(
        ledger.receipt_tree().leaf(applied.position).unwrap(),
        peal_bonsai::wallet::receipt_commitment(&f.inst, &opening)
    );
    (opening, applied.position)
}

#[test]
fn batch_isolates_invalid_proofs_and_resolves_races_deterministically() {
    let f = fixture();
    let ns = namespace_id("test/ns-b");
    let mut rng = peal_bonsai::os_rng();
    let mut ledger = Ledger::open_in_memory(
        f.inst.clone(),
        VerifyingKeys::from(&f.keys),
        config(f, "test/ns-b"),
    )
    .unwrap();
    let mut alice = Wallet::create(&f.inst, f.keys.circuit_id, ns, &mut rng);
    let mut bob = Wallet::create(&f.inst, f.keys.circuit_id, ns, &mut rng);
    for w in [&mut alice, &mut bob] {
        ledger.register(&w.register_envelope().unwrap()).unwrap();
        w.registered = true;
    }
    mint(f, &mut ledger, &mut alice, 10_000, "31337:0xdef:1");
    claim(f, &mut ledger, &mut alice, 0);

    // Two valid proofs from the same old state (a device race), one
    // tampered proof, all in one batch.
    let root = ledger.receipt_root();
    let mut alice2 = Wallet::from_json(&alice.to_json()).unwrap();
    let c1 = alice
        .prepare_send(&f.inst, 10, bob.account, root, None, 1, &mut rng)
        .unwrap();
    let e1 = alice.prove_pending(&f.keys, c1, &mut rng).unwrap();
    let c2 = alice2
        .prepare_send(&f.inst, 20, bob.account, root, None, 1, &mut rng)
        .unwrap();
    let e2 = alice2.prove_pending(&f.keys, c2, &mut rng).unwrap();
    let mut bad = e2.clone();
    bad.proof[5] ^= 0x40;
    let bad = OpEnvelope::sign(
        &alice.spend_key(),
        bad.namespace,
        bad.circuit_id,
        bad.account,
        bad.com,
        bad.com_new,
        bad.receipt,
        bad.root,
        bad.proof,
    );
    // Also a proof that verifies on its own but is for the wrong statement
    // (a valid proof for Bob's registration commitment is not tested here;
    // the flipped byte covers the batch-fallback path).
    let results = ledger.apply_batch(&[bad, e1.clone(), e2.clone()], &mut rng);
    assert!(
        matches!(
            results[0],
            Err(Error::InvalidPoint) | Err(Error::InvalidProof)
        ),
        "{:?}",
        results[0]
    );
    assert!(results[1].is_ok(), "{:?}", results[1]);
    assert_eq!(results[2], Err(Error::StaleCommitment));
    alice
        .commit_pending(results[1].as_ref().unwrap().position, 1)
        .unwrap();
    alice2.abort_pending();
    assert_eq!(alice.balance, 9_990);

    // The batch verifier itself, exercised directly: mixing one bad proof
    // into a batch of good ones fails the batch, and each good one still
    // verifies alone.
    let good_proof = peal_bonsai::encoding::proof_from_bytes(&e1.proof).unwrap();
    let mut claims = Vec::new();
    for _ in 0..3 {
        claims.push((
            good_proof.clone(),
            vec![
                e1.account,
                alice2.commitment(&f.inst),
                e1.com_new,
                e1.receipt,
                e1.root,
            ],
        ));
    }
    assert!(ZkPari::<peal_bonsai::E>::batch_verify(
        &claims,
        &f.keys.op.vk,
        &mut rng
    ));
    let mut wrong = claims[0].clone();
    wrong.1[2] = Fr::from(1u64);
    claims.push(wrong);
    assert!(!ZkPari::<peal_bonsai::E>::batch_verify(
        &claims,
        &f.keys.op.vk,
        &mut rng
    ));
    assert_eq!(proof_to_bytes(&good_proof).len(), 128);
}

/// Batched and replayed application must accept exactly the same
/// operations: the recent-root window is judged at application time.
#[test]
fn batch_application_respects_the_root_window_and_replays_identically() {
    let f = fixture();
    let ns = namespace_id("test/ns-w");
    let mut rng = peal_bonsai::os_rng();
    let cfg = LedgerConfig {
        namespace: ns,
        circuit_id: f.keys.circuit_id,
        root_window: 3,
    };
    let db = f.dir.path().join("ledger-w.sqlite");
    let mut ledger = Ledger::open(&db, f.inst.clone(), VerifyingKeys::from(&f.keys), cfg).unwrap();
    // Four funded wallets, each proving a claim against the same root.
    let mut wallets = Vec::new();
    for i in 0..4 {
        let mut w = Wallet::create(&f.inst, f.keys.circuit_id, ns, &mut rng);
        ledger.register(&w.register_envelope().unwrap()).unwrap();
        w.registered = true;
        mint(f, &mut ledger, &mut w, 10, &format!("w:{i}"));
        wallets.push(w);
    }
    let root = ledger.receipt_root();
    let mut envs = Vec::new();
    for w in wallets.iter_mut() {
        let witness = ReceiptWitness {
            path: ledger.receipt_tree().path(w.receipts[0].position).unwrap(),
            root,
        };
        let c = w
            .prepare_receive(&f.inst, 0, &witness, 1, &mut rng)
            .unwrap();
        envs.push(w.prove_pending(&f.keys, c, &mut rng).unwrap());
    }
    // Window 3 covers the roots at sizes S, S+1, S+2: the first three land,
    // the fourth reveals a root that is three appends old by then.
    let results = ledger.apply_batch(&envs, &mut rng);
    assert!(
        results[0].is_ok() && results[1].is_ok() && results[2].is_ok(),
        "{results:?}"
    );
    assert_eq!(results[3], Err(Error::RootNotRecent));
    // Replay from the store agrees with what was applied.
    assert_eq!(ledger.verify_replay().unwrap(), ledger.state_root());
    // Reopening restores the same window.
    let root_before = ledger.state_root();
    drop(ledger);
    let cfg = LedgerConfig {
        namespace: ns,
        circuit_id: f.keys.circuit_id,
        root_window: 3,
    };
    let ledger = Ledger::open(&db, f.inst.clone(), VerifyingKeys::from(&f.keys), cfg).unwrap();
    assert_eq!(ledger.state_root(), root_before);
    assert_eq!(ledger.recent_roots().len(), 3);
}
