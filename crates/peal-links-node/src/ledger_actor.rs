//! One thread per namespace owns its `Ledger`. Every access goes through a
//! command channel, which gives two things for free: the sqlite connection
//! and the in-memory receipt tree are never shared, and operations that
//! arrive close together are verified as one batch.
//!
//! Batching policy: when an `Apply` arrives, the actor keeps draining
//! further `Apply` commands for up to `window` or `max` operations, then
//! calls `apply_batch`, which batch-verifies and applies in order. Under low
//! load the window is the only added latency (default 25 ms); under high
//! load the batch fills and the window is never waited for. Measured in
//! BENCHMARKS.md.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use peal_bonsai::account::{OpEnvelope, RegisterEnvelope};
use peal_bonsai::deposit::MintEnvelope;
use peal_bonsai::encoding::fr_to_hex;
use peal_bonsai::ledger::{AccountView, Applied, HistoryRow, Ledger};
use peal_bonsai::Fr;
use serde::Serialize;
use tokio::sync::oneshot;

#[derive(Clone, Serialize)]
pub struct Summary {
    pub namespace: String,
    pub seq: u64,
    pub receipt_count: u64,
    pub receipt_root: String,
    pub state_root: String,
    pub recent_roots: Vec<String>,
    pub minted_total: String,
}

#[derive(Serialize)]
pub struct PathOut {
    pub position: u64,
    pub size: u64,
    pub root: String,
    pub leaf: String,
    pub siblings: Vec<String>,
    pub index_bits: Vec<bool>,
}

pub enum Command {
    Apply(OpEnvelope, oneshot::Sender<peal_bonsai::Result<Applied>>),
    Register(
        RegisterEnvelope,
        oneshot::Sender<peal_bonsai::Result<Applied>>,
    ),
    Mint(MintEnvelope, oneshot::Sender<peal_bonsai::Result<Applied>>),
    Account(
        Fr,
        oneshot::Sender<peal_bonsai::Result<Option<AccountView>>>,
    ),
    Summary(oneshot::Sender<Summary>),
    Path(
        u64,
        Option<u64>,
        oneshot::Sender<peal_bonsai::Result<PathOut>>,
    ),
    History(
        u64,
        usize,
        oneshot::Sender<peal_bonsai::Result<Vec<HistoryRow>>>,
    ),
}

#[derive(Clone)]
pub struct LedgerHandle {
    tx: Sender<Command>,
}

impl LedgerHandle {
    pub fn spawn(mut ledger: Ledger, window: Duration, max: usize) -> Self {
        let (tx, rx) = mpsc::channel::<Command>();
        std::thread::Builder::new()
            .name("ledger-actor".into())
            // No tracing subscriber on this thread: proof verification runs
            // arkworks code that would otherwise open a span per operation.
            .spawn(move || {
                tracing::subscriber::with_default(
                    tracing::subscriber::NoSubscriber::default(),
                    || run(&mut ledger, rx, window, max),
                )
            })
            .expect("spawn ledger actor");
        Self { tx }
    }

    async fn ask<T>(&self, make: impl FnOnce(oneshot::Sender<T>) -> Command) -> T {
        let (tx, rx) = oneshot::channel();
        self.tx.send(make(tx)).expect("ledger actor alive");
        rx.await.expect("ledger actor answers")
    }

    pub async fn apply(&self, env: OpEnvelope) -> peal_bonsai::Result<Applied> {
        self.ask(|tx| Command::Apply(env, tx)).await
    }
    pub async fn register(&self, env: RegisterEnvelope) -> peal_bonsai::Result<Applied> {
        self.ask(|tx| Command::Register(env, tx)).await
    }
    pub async fn mint(&self, env: MintEnvelope) -> peal_bonsai::Result<Applied> {
        self.ask(|tx| Command::Mint(env, tx)).await
    }
    pub async fn account(&self, id: Fr) -> peal_bonsai::Result<Option<AccountView>> {
        self.ask(|tx| Command::Account(id, tx)).await
    }
    pub async fn summary(&self) -> Summary {
        self.ask(Command::Summary).await
    }
    pub async fn path(&self, pos: u64, size: Option<u64>) -> peal_bonsai::Result<PathOut> {
        self.ask(|tx| Command::Path(pos, size, tx)).await
    }
    pub async fn history(&self, from: u64, limit: usize) -> peal_bonsai::Result<Vec<HistoryRow>> {
        self.ask(|tx| Command::History(from, limit, tx)).await
    }
}

fn summary(ledger: &Ledger) -> Summary {
    Summary {
        namespace: hex::encode(ledger.config().namespace),
        seq: ledger.seq(),
        receipt_count: ledger.receipt_count(),
        receipt_root: fr_to_hex(&ledger.receipt_root()),
        state_root: hex::encode(ledger.state_root()),
        recent_roots: ledger.recent_roots().iter().map(fr_to_hex).collect(),
        minted_total: ledger
            .minted_total()
            .map(|v| v.to_string())
            .unwrap_or_default(),
    }
}

fn path(ledger: &Ledger, pos: u64, size: Option<u64>) -> peal_bonsai::Result<PathOut> {
    let tree = ledger.receipt_tree();
    let size = size.unwrap_or(tree.size());
    let p = tree.path_at(pos, size)?;
    Ok(PathOut {
        position: pos,
        size,
        root: fr_to_hex(&tree.root_at(size)?),
        leaf: fr_to_hex(&tree.leaf(pos).expect("path_at checked the position")),
        siblings: p.siblings.iter().map(fr_to_hex).collect(),
        index_bits: p.index_bits,
    })
}

fn run(ledger: &mut Ledger, rx: Receiver<Command>, window: Duration, max: usize) {
    let mut rng = peal_bonsai::os_rng();
    while let Ok(cmd) = rx.recv() {
        match cmd {
            Command::Apply(env, reply) => {
                // Gather a batch: everything that arrives within the window.
                let mut envs = vec![env];
                let mut replies = vec![reply];
                let mut deferred = Vec::new();
                let deadline = Instant::now() + window;
                while envs.len() < max {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        break;
                    }
                    match rx.recv_timeout(left) {
                        Ok(Command::Apply(e, r)) => {
                            envs.push(e);
                            replies.push(r);
                        }
                        Ok(other) => deferred.push(other),
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
                let started = Instant::now();
                let results = ledger.apply_batch(&envs, &mut rng);
                tracing::debug!(
                    batch = envs.len(),
                    ms = started.elapsed().as_millis() as u64,
                    "ledger batch applied"
                );
                for (r, reply) in results.into_iter().zip(replies) {
                    let _ = reply.send(r);
                }
                for cmd in deferred {
                    handle(ledger, cmd);
                }
            }
            other => handle(ledger, other),
        }
    }
}

fn handle(ledger: &mut Ledger, cmd: Command) {
    match cmd {
        Command::Apply(env, reply) => {
            let _ = reply.send(ledger.apply(&env));
        }
        Command::Register(env, reply) => {
            let _ = reply.send(ledger.register(&env));
        }
        Command::Mint(env, reply) => {
            let _ = reply.send(ledger.mint(&env));
        }
        Command::Account(id, reply) => {
            let _ = reply.send(ledger.account(&id));
        }
        Command::Summary(reply) => {
            let _ = reply.send(summary(ledger));
        }
        Command::Path(pos, size, reply) => {
            let _ = reply.send(path(ledger, pos, size));
        }
        Command::History(from, limit, reply) => {
            let _ = reply.send(ledger.history(from, limit.min(500)));
        }
    }
}
