//! Four validators on the deterministic runtime and the simulated network
//! order real registrations, mints and proofs and end with identical
//! ledgers. Nothing here is a double: the same `Ledger`, the same ZK-Pari
//! verifier and the same simplex engine as the live stack.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use commonware_cryptography::Signer;
use commonware_p2p::simulated::{Config as NetConfig, Link, Network};
use commonware_runtime::{deterministic, Clock, Runner, Supervisor};
use commonware_utils::{probability, NZUsize};
use futures::future::BoxFuture;
use peal_bonsai::account::{namespace_id, Namespace};
use peal_bonsai::deposit::MintEnvelope;
use peal_bonsai::ledger::{Ledger, LedgerConfig, VerifyingKeys};
use peal_bonsai::params::{Instance, Keys};
use peal_bonsai::wallet::{PendingKind, ReceiptWitness, Wallet};
use peal_bonsai::{Error, Fr};
use peal_links_consensus::engine::Params;
use peal_links_consensus::sim::{self, SimValidator};
use peal_links_consensus::{
    genesis, AppHandler, DepositOracle, Envelope, Handle, PrivateKey, PublicKey, Shared, State, Tx,
};

struct Fixture {
    inst: Instance,
    keys: Keys,
    _dir: tempfile::TempDir,
}

fn fixture() -> &'static Fixture {
    static F: OnceLock<Fixture> = OnceLock::new();
    F.get_or_init(|| {
        let inst = Instance::default_instance();
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::load_or_generate(&inst, &dir.path().join("params")).unwrap();
        Fixture {
            inst,
            keys,
            _dir: dir,
        }
    })
}

const NS_LABEL: &str = "sim/tUSD";
const SUBMIT_TIMEOUT: Duration = Duration::from_secs(30);

/// Deposits the test "observed on chain": every validator consults the
/// same table, as every live validator consults the same chain.
#[derive(Default)]
struct Deposits(Mutex<HashMap<String, (u64, Fr)>>);

impl DepositOracle for Deposits {
    fn confirmed(
        &self,
        _ns: Namespace,
        env: MintEnvelope,
    ) -> BoxFuture<'static, Result<bool, String>> {
        let ok = self
            .0
            .lock()
            .unwrap()
            .get(&env.deposit_id)
            .map(|(amount, receipt)| *amount == env.intent.amount && *receipt == env.intent.receipt)
            .unwrap_or(false);
        Box::pin(async move { Ok(ok) })
    }
}

/// Echo handler: answers every request with its body reversed, so a test
/// can see which validators answered.
struct Echo;

impl AppHandler for Echo {
    fn handle(&self, _from: PublicKey, body: Vec<u8>) -> BoxFuture<'static, Option<Vec<u8>>> {
        Box::pin(async move { Some(body.into_iter().rev().collect()) })
    }
}

fn new_state(f: &Fixture, ns: Namespace, g: [u8; 32]) -> Shared {
    let ledger = Ledger::open_in_memory(
        f.inst.clone(),
        VerifyingKeys::from(&f.keys),
        LedgerConfig {
            namespace: ns,
            circuit_id: f.keys.circuit_id,
            root_window: 8,
        },
    )
    .unwrap();
    let mut ledgers = HashMap::new();
    ledgers.insert(ns, ledger);
    Arc::new(Mutex::new(State::open(ledgers, None, g).unwrap()))
}

struct Cluster {
    handles: Vec<Handle>,
    states: Vec<Shared>,
    deposits: Arc<Deposits>,
    oracle: sim::SimOracle,
}

/// Start `running` of `n` validators (the rest exist in the set but never
/// come online).
async fn cluster(
    context: &deterministic::Context,
    f: &Fixture,
    ns: Namespace,
    n: usize,
    running: usize,
) -> Cluster {
    let privs: Vec<PrivateKey> = (0..n as u64).map(PrivateKey::from_seed).collect();
    let pubs: Vec<PublicKey> = privs.iter().map(|k| k.public_key()).collect();
    let g = genesis(&f.keys.circuit_id, &[ns]);
    let (network, oracle) = Network::new_with_peers(
        context.child("network"),
        NetConfig {
            max_size: 1024 * 1024,
            max_peers_per_set: NZUsize!(n + 1),
            disconnect_on_block: true,
            tracked_peer_sets: NZUsize!(1),
        },
        pubs.clone(),
    )
    .await;
    network.start();
    let link = Link {
        latency: Duration::from_millis(20),
        jitter: Duration::from_millis(2),
        success_rate: probability!(1.0),
    };
    for a in &pubs {
        for b in &pubs {
            if a != b {
                oracle
                    .add_link(a.clone(), b.clone(), link.clone())
                    .await
                    .unwrap();
            }
        }
    }
    let deposits = Arc::new(Deposits::default());
    let mut handles = Vec::new();
    let mut states = Vec::new();
    for (i, key) in privs.iter().enumerate().take(running) {
        let state = new_state(f, ns, g);
        states.push(state.clone());
        let handle = sim::start(
            context.child("validator").with_attribute("index", i),
            &oracle,
            SimValidator {
                private_key: key.clone(),
                validators: pubs.clone(),
                genesis: g,
                params: Params::default(),
                max_block_txs: 32,
                mempool_ttl: Duration::from_secs(60),
            },
            state,
            deposits.clone(),
            Arc::new(Echo),
        )
        .await;
        handles.push(handle);
    }
    Cluster {
        handles,
        states,
        deposits,
        oracle,
    }
}

fn heads(c: &Cluster) -> Vec<(u64, String, String)> {
    c.states
        .iter()
        .map(|s| {
            let s = s.lock().unwrap();
            let h = s.head();
            (h.height, hex::encode(h.digest), hex::encode(h.root))
        })
        .collect()
}

async fn settle(context: &deterministic::Context, c: &Cluster) {
    // A few views so every validator applies what the leader finalized.
    for _ in 0..40 {
        context.sleep(Duration::from_millis(250)).await;
        let hs = heads(c);
        if hs.iter().all(|h| h == &hs[0]) && hs[0].0 > 0 {
            let statuses = futures::future::join_all(c.handles.iter().map(|h| h.status())).await;
            if statuses.iter().all(|s| {
                s.as_ref()
                    .map(|s| s.pending_finalized == 0)
                    .unwrap_or(false)
            }) {
                return;
            }
        }
    }
}

#[test]
fn four_validators_agree_on_the_ledger() {
    let f = fixture();
    let ns = namespace_id(NS_LABEL);
    let executor = deterministic::Runner::timed(Duration::from_secs(600));
    executor.start(|context| async move {
        let c = cluster(&context, f, ns, 4, 4).await;
        let mut rng = peal_bonsai::os_rng();
        let mut alice = Wallet::create(&f.inst, f.keys.circuit_id, ns, &mut rng);
        let mut bob = Wallet::create(&f.inst, f.keys.circuit_id, ns, &mut rng);

        // Registrations submitted to two different validators.
        let alice_register = alice.register_envelope().unwrap();
        let a = c.handles[0]
            .submit(
                Tx {
                    namespace: ns,
                    envelope: Envelope::Register(alice_register.clone()),
                },
                SUBMIT_TIMEOUT,
            )
            .await
            .unwrap();
        alice.registered = true;
        let b = c.handles[1]
            .submit(
                Tx {
                    namespace: ns,
                    envelope: Envelope::Register(bob.register_envelope().unwrap()),
                },
                SUBMIT_TIMEOUT,
            )
            .await
            .unwrap();
        bob.registered = true;
        assert!(a.seq < b.seq, "the ledger orders both registrations");
        // A repeat is refused at the ledger, on every validator alike.
        let dup = c.handles[2]
            .submit(
                Tx {
                    namespace: ns,
                    envelope: Envelope::Register(alice_register),
                },
                SUBMIT_TIMEOUT,
            )
            .await;
        assert!(matches!(dup, Err(Error::AccountExists)), "{dup:?}");

        // A mint: the deposit intent carries a real R_dep proof and the
        // validators confirm the deposit against their (shared) chain view.
        let (intent, _opening) = alice
            .prepare_deposit(&f.inst, &f.keys, 1_000_000, None, 1, &mut rng)
            .unwrap();
        let unconfirmed = c.handles[2]
            .submit(
                Tx {
                    namespace: ns,
                    envelope: Envelope::Mint(MintEnvelope {
                        intent: intent.clone(),
                        deposit_id: "31337:0xnotyet:0".into(),
                    }),
                },
                Duration::from_secs(20),
            )
            .await;
        assert!(
            unconfirmed.is_err(),
            "a mint no validator can confirm is never finalized: {unconfirmed:?}"
        );
        c.deposits
            .0
            .lock()
            .unwrap()
            .insert("31337:0xabc:0".into(), (1_000_000, intent.receipt));
        let minted = c.handles[2]
            .submit(
                Tx {
                    namespace: ns,
                    envelope: Envelope::Mint(MintEnvelope {
                        intent: intent.clone(),
                        deposit_id: "31337:0xabc:0".into(),
                    }),
                },
                SUBMIT_TIMEOUT,
            )
            .await
            .unwrap();
        settle(&context, &c).await;
        {
            let s = c.states[3].lock().unwrap();
            let ledger = s.ledger(&ns).unwrap();
            let idx = alice
                .deposit_minted(
                    &f.inst,
                    ledger.receipt_tree().leaf(minted.position).unwrap(),
                    minted.position,
                    1,
                )
                .unwrap();
            let witness = ReceiptWitness {
                path: ledger.receipt_tree().path(minted.position).unwrap(),
                root: ledger.receipt_root(),
            };
            assert!(alice.verify_receipt(&f.inst, idx, &witness).unwrap());
        }
        // Claim the mint receipt (a receive proof), submitted to validator 3.
        let claim_env = {
            let s = c.states[3].lock().unwrap();
            let ledger = s.ledger(&ns).unwrap();
            let witness = ReceiptWitness {
                path: ledger.receipt_tree().path(minted.position).unwrap(),
                root: ledger.receipt_root(),
            };
            let circuit = alice
                .prepare_receive(&f.inst, 0, &witness, 2, &mut rng)
                .unwrap();
            alice.prove_pending(&f.keys, circuit, &mut rng).unwrap()
        };
        let claimed = c.handles[3]
            .submit(
                Tx {
                    namespace: ns,
                    envelope: Envelope::Op(claim_env),
                },
                SUBMIT_TIMEOUT,
            )
            .await
            .unwrap();
        alice.commit_pending(claimed.position, 2).unwrap();
        assert_eq!(alice.balances(), (1_000_000, 0));

        // Alice pays Bob through validator 1; Bob claims through validator 0.
        settle(&context, &c).await;
        let (send_env, opening) = {
            let s = c.states[1].lock().unwrap();
            let root = s.ledger(&ns).unwrap().receipt_root();
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
            let opening = match &alice.pending.as_ref().unwrap().kind {
                PendingKind::Send { opening, .. } => opening.clone(),
                _ => unreachable!(),
            };
            (
                alice.prove_pending(&f.keys, circuit, &mut rng).unwrap(),
                opening,
            )
        };
        // The same proof submitted twice: one lands, the other is stale.
        let (first, second) = futures::future::join(
            c.handles[1].submit(
                Tx {
                    namespace: ns,
                    envelope: Envelope::Op(send_env.clone()),
                },
                SUBMIT_TIMEOUT,
            ),
            c.handles[2].submit(
                Tx {
                    namespace: ns,
                    envelope: Envelope::Op(send_env.clone()),
                },
                SUBMIT_TIMEOUT,
            ),
        )
        .await;
        let sent = first.unwrap();
        // Identical bytes are one transaction: both submitters see the same result.
        assert_eq!(second.unwrap().position, sent.position);
        alice.commit_pending(sent.position, 3).unwrap();
        // Replaying the spent proof is refused: the account moved on.
        let replay = c.handles[0]
            .submit(
                Tx {
                    namespace: ns,
                    envelope: Envelope::Op(send_env.clone()),
                },
                SUBMIT_TIMEOUT,
            )
            .await;
        assert!(replay.is_err(), "{replay:?}");

        settle(&context, &c).await;
        let idx = bob.add_receipt(&f.inst, sent.position, opening, Some("req-1".into()), 4);
        let claim_env = {
            let s = c.states[0].lock().unwrap();
            let ledger = s.ledger(&ns).unwrap();
            let witness = ReceiptWitness {
                path: ledger.receipt_tree().path(sent.position).unwrap(),
                root: ledger.receipt_root(),
            };
            assert!(bob.verify_receipt(&f.inst, idx, &witness).unwrap());
            let circuit = bob
                .prepare_receive(&f.inst, idx, &witness, 5, &mut rng)
                .unwrap();
            bob.prove_pending(&f.keys, circuit, &mut rng).unwrap()
        };
        let claimed = c.handles[0]
            .submit(
                Tx {
                    namespace: ns,
                    envelope: Envelope::Op(claim_env),
                },
                SUBMIT_TIMEOUT,
            )
            .await
            .unwrap();
        bob.commit_pending(claimed.position, 5).unwrap();
        assert_eq!(bob.balances(), (250_000, 0));
        assert_eq!(alice.balances(), (750_000, 0));

        // A tampered proof is refused before it reaches the mempool.
        let mut bad = send_env.clone();
        bad.proof[10] ^= 1;
        let rejected = c.handles[0]
            .submit(
                Tx {
                    namespace: ns,
                    envelope: Envelope::Op(bad),
                },
                SUBMIT_TIMEOUT,
            )
            .await;
        assert!(matches!(rejected, Err(Error::BadSignature)), "{rejected:?}");

        // Every validator holds the same ledger.
        settle(&context, &c).await;
        let hs = heads(&c);
        assert!(hs.iter().all(|h| h == &hs[0]), "heads differ: {hs:?}");
        assert!(hs[0].0 >= 5, "at least five non-empty blocks: {hs:?}");
        let summaries: Vec<_> = c
            .states
            .iter()
            .map(|s| s.lock().unwrap().summary(&ns).unwrap())
            .collect();
        assert!(
            summaries.iter().all(|s| s == &summaries[0]),
            "ledgers differ: {summaries:?}"
        );
        assert_eq!(summaries[0].seq, 6, "register x2, mint, claim, send, claim");
        // Replay on one validator re-verifies every proof and reproduces the root.
        let root = hex::encode(
            c.states[2]
                .lock()
                .unwrap()
                .ledger(&ns)
                .unwrap()
                .verify_replay()
                .unwrap(),
        );
        assert_eq!(root, summaries[0].state_root);

        // Application requests reach every other validator.
        let answers = c.handles[0]
            .gather(vec![1, 2, 3], 3, Duration::from_secs(5))
            .await;
        assert_eq!(answers.len(), 3, "{answers:?}");
        assert!(answers.iter().all(|(_, body)| body == &[3, 2, 1]));
    });
}

#[test]
fn three_of_four_validators_finalize_without_the_fourth() {
    let f = fixture();
    let ns = namespace_id("sim/three-of-four");
    let executor = deterministic::Runner::timed(Duration::from_secs(300));
    executor.start(|context| async move {
        let c = cluster(&context, f, ns, 4, 3).await;
        let mut rng = peal_bonsai::os_rng();
        let mut alice = Wallet::create(&f.inst, f.keys.circuit_id, ns, &mut rng);
        let applied = c.handles[2]
            .submit(
                Tx {
                    namespace: ns,
                    envelope: Envelope::Register(alice.register_envelope().unwrap()),
                },
                Duration::from_secs(60),
            )
            .await
            .unwrap();
        alice.registered = true;
        assert_eq!(applied.seq, 1);
        settle(&context, &c).await;
        let hs = heads(&c);
        assert!(hs.iter().all(|h| h == &hs[0]), "heads differ: {hs:?}");
    });
}

#[test]
fn a_validator_that_missed_blocks_catches_up_by_digest() {
    let f = fixture();
    let ns = namespace_id("sim/catch-up");
    let executor = deterministic::Runner::timed(Duration::from_secs(300));
    executor.start(|context| async move {
        // Four validators, three running: the chain advances without the fourth.
        let mut c = cluster(&context, f, ns, 4, 3).await;
        let mut rng = peal_bonsai::os_rng();
        let mut wallets = Vec::new();
        for i in 0..3 {
            let mut w = Wallet::create(&f.inst, f.keys.circuit_id, ns, &mut rng);
            c.handles[i]
                .submit(
                    Tx {
                        namespace: ns,
                        envelope: Envelope::Register(w.register_envelope().unwrap()),
                    },
                    Duration::from_secs(60),
                )
                .await
                .unwrap();
            w.registered = true;
            wallets.push(w);
        }
        settle(&context, &c).await;
        let before = heads(&c);
        assert!(before[0].0 >= 3);
        // The fourth validator comes online with an empty ledger and must
        // fetch every finalized block by digest from its peers.
        let g = genesis(&f.keys.circuit_id, &[ns]);
        let state = new_state(f, ns, g);
        let privs: Vec<PrivateKey> = (0..4u64).map(PrivateKey::from_seed).collect();
        let pubs: Vec<PublicKey> = privs.iter().map(|k| k.public_key()).collect();
        let handle = sim::start(
            context.child("late"),
            &c.oracle,
            SimValidator {
                private_key: privs[3].clone(),
                validators: pubs,
                genesis: g,
                params: Params::default(),
                max_block_txs: 32,
                mempool_ttl: Duration::from_secs(60),
            },
            state.clone(),
            c.deposits.clone(),
            Arc::new(Echo),
        )
        .await;
        c.handles.push(handle);
        c.states.push(state);
        // One more registration so a new finalization reaches the late validator.
        let mut w = Wallet::create(&f.inst, f.keys.circuit_id, ns, &mut rng);
        c.handles[0]
            .submit(
                Tx {
                    namespace: ns,
                    envelope: Envelope::Register(w.register_envelope().unwrap()),
                },
                Duration::from_secs(60),
            )
            .await
            .unwrap();
        w.registered = true;
        for _ in 0..80 {
            context.sleep(Duration::from_millis(250)).await;
            let hs = heads(&c);
            if hs.iter().all(|h| h == &hs[0]) {
                break;
            }
        }
        let hs = heads(&c);
        assert!(
            hs.iter().all(|h| h == &hs[0]),
            "late validator did not catch up: {hs:?}"
        );
        assert!(hs[0].0 > before[0].0);
    });
}
