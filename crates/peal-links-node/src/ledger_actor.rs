//! Access to a namespace's ledger, in one of two shapes behind one handle.
//!
//! **Local**: one thread per namespace owns its `Ledger`. Every access goes
//! through a command channel, which gives two things for free: the sqlite
//! connection and the in-memory receipt tree are never shared, and
//! operations that arrive close together are verified as one batch.
//! Batching policy: when an `Apply` arrives, the actor keeps draining
//! further `Apply` commands for up to `window` or `max` operations, then
//! calls `apply_batch`, which batch-verifies and applies in order. Under low
//! load the window is the only added latency (default 25 ms); under high
//! load the batch fills and the window is never waited for. Measured in
//! BENCHMARKS.md.
//!
//! **Replicated** (decision 0010): the ledger belongs to the consensus
//! state shared by every validator. Writes are submitted to consensus and
//! answered once a finalized block applied them; reads come straight from
//! the replicated state.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use peal_bonsai::account::{Namespace, OpEnvelope, RegisterEnvelope};
use peal_bonsai::deposit::MintEnvelope;
use peal_bonsai::encoding::fr_to_hex;
use peal_bonsai::ledger::{AccountView, Applied, HistoryRow, Ledger};
use peal_bonsai::Fr;
use peal_links_consensus::{Envelope, Tx};
use tokio::sync::oneshot;

pub use peal_links_consensus::state::{LedgerSummary as Summary, ReceiptPath as PathOut};

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
pub struct Replicated {
    namespace: Namespace,
    state: peal_links_consensus::Shared,
    consensus: peal_links_consensus::Handle,
    submit_timeout: Duration,
}

#[derive(Clone)]
pub enum LedgerHandle {
    Local(Sender<Command>),
    Replicated(Box<Replicated>),
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
        Self::Local(tx)
    }

    pub fn replicated(
        namespace: Namespace,
        state: peal_links_consensus::Shared,
        consensus: peal_links_consensus::Handle,
        submit_timeout: Duration,
    ) -> Self {
        Self::Replicated(Box::new(Replicated {
            namespace,
            state,
            consensus,
            submit_timeout,
        }))
    }

    pub fn is_replicated(&self) -> bool {
        matches!(self, Self::Replicated(_))
    }

    async fn ask<T>(tx: &Sender<Command>, make: impl FnOnce(oneshot::Sender<T>) -> Command) -> T {
        let (reply, rx) = oneshot::channel();
        tx.send(make(reply)).expect("ledger actor alive");
        rx.await.expect("ledger actor answers")
    }

    async fn submit(
        consensus: &peal_links_consensus::Handle,
        namespace: Namespace,
        envelope: Envelope,
        timeout: Duration,
    ) -> peal_bonsai::Result<Applied> {
        consensus
            .submit(
                Tx {
                    namespace,
                    envelope,
                },
                timeout,
            )
            .await
    }

    pub async fn apply(&self, env: OpEnvelope) -> peal_bonsai::Result<Applied> {
        match self {
            Self::Local(tx) => Self::ask(tx, |r| Command::Apply(env, r)).await,
            Self::Replicated(r) => {
                Self::submit(
                    &r.consensus,
                    r.namespace,
                    Envelope::Op(env),
                    r.submit_timeout,
                )
                .await
            }
        }
    }

    pub async fn register(&self, env: RegisterEnvelope) -> peal_bonsai::Result<Applied> {
        match self {
            Self::Local(tx) => Self::ask(tx, |r| Command::Register(env, r)).await,
            Self::Replicated(r) => {
                Self::submit(
                    &r.consensus,
                    r.namespace,
                    Envelope::Register(env),
                    r.submit_timeout,
                )
                .await
            }
        }
    }

    pub async fn mint(&self, env: MintEnvelope) -> peal_bonsai::Result<Applied> {
        match self {
            Self::Local(tx) => Self::ask(tx, |r| Command::Mint(env, r)).await,
            Self::Replicated(r) => {
                Self::submit(
                    &r.consensus,
                    r.namespace,
                    Envelope::Mint(env),
                    r.submit_timeout,
                )
                .await
            }
        }
    }

    pub async fn account(&self, id: Fr) -> peal_bonsai::Result<Option<AccountView>> {
        match self {
            Self::Local(tx) => Self::ask(tx, |r| Command::Account(id, r)).await,
            Self::Replicated(r) => {
                peal_links_consensus::state::lock(&r.state).account(&r.namespace, &id)
            }
        }
    }

    pub async fn summary(&self) -> Summary {
        match self {
            Self::Local(tx) => Self::ask(tx, Command::Summary).await,
            Self::Replicated(r) => peal_links_consensus::state::lock(&r.state)
                .summary(&r.namespace)
                .expect("namespace is served"),
        }
    }

    pub async fn path(&self, pos: u64, size: Option<u64>) -> peal_bonsai::Result<PathOut> {
        match self {
            Self::Local(tx) => Self::ask(tx, |r| Command::Path(pos, size, r)).await,
            Self::Replicated(r) => {
                peal_links_consensus::state::lock(&r.state).path(&r.namespace, pos, size)
            }
        }
    }

    pub async fn history(&self, from: u64, limit: usize) -> peal_bonsai::Result<Vec<HistoryRow>> {
        match self {
            Self::Local(tx) => Self::ask(tx, |r| Command::History(from, limit, r)).await,
            Self::Replicated(r) => {
                peal_links_consensus::state::lock(&r.state).history(&r.namespace, from, limit)
            }
        }
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
