//! The application actor: what the engine calls (propose, verify,
//! broadcast, report) on one side, what the node calls (submit, status,
//! gather) on the other, and the mempool, block cache and finalization
//! queue in between.
//!
//! The actor owns no ledger; it holds the shared `State` lock briefly for
//! stateless checks (a proof verification each, about a millisecond) and
//! for applying finalized blocks. Verification of a proposed block runs
//! in its own task because it may wait on the deposit oracle.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use commonware_actor::Feedback;
use commonware_consensus::simplex::scheme::ed25519::Scheme;
use commonware_consensus::simplex::types::{Activity, Context};
use commonware_consensus::simplex::Plan;
use commonware_consensus::{Automaton, CertifiableAutomaton, Relay, Reporter};
use commonware_cryptography::sha256::Digest;
use commonware_p2p::{Recipients, Sender};
use commonware_runtime::{Clock, Metrics, Spawner, Supervisor};
use futures::future::BoxFuture;
use peal_bonsai::account::Namespace;
use peal_bonsai::deposit::MintEnvelope;
use peal_bonsai::ledger::Applied;
use serde::Serialize;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, warn};

use crate::block::{Block, Envelope, Id, Tx, MAX_BLOCK_BYTES};
use crate::state::{lock, Head, Shared};
use crate::wire::{AppWire, BlockWire, CH_APP, CH_BLOCKS, CH_TXS};
use crate::PublicKey;

pub type Ctx = Context<Digest, PublicKey>;
/// A submitter's reply channel with its deadline.
pub type SubmitWaiter = (oneshot::Sender<peal_bonsai::Result<Applied>>, Duration);

/// How a validator confirms, from its own view of the chain, that a
/// deposit a proposer wants to mint really happened. `Ok(true)` confirms,
/// `Ok(false)` denies (the validator votes against the block), `Err`
/// means the chain could not be consulted (the validator abstains).
pub trait DepositOracle: Send + Sync + 'static {
    fn confirmed(
        &self,
        namespace: Namespace,
        env: MintEnvelope,
    ) -> BoxFuture<'static, Result<bool, String>>;
}

/// Application requests between validators (settlement signatures). A
/// `None` answer sends nothing back.
pub trait AppHandler: Send + Sync + 'static {
    fn handle(&self, from: PublicKey, body: Vec<u8>) -> BoxFuture<'static, Option<Vec<u8>>>;
}

/// Everything a validator reports about itself.
#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub validator: String,
    pub validators: Vec<String>,
    pub height: u64,
    pub head: String,
    pub state_root: String,
    pub genesis: String,
    pub mempool: usize,
    pub finalized_seen: u64,
    pub last_finalized_view: u64,
    pub blocks_cached: usize,
    pub pending_finalized: usize,
}

pub enum Message {
    Propose {
        context: Ctx,
        response: oneshot::Sender<Digest>,
    },
    Verify {
        context: Ctx,
        payload: Digest,
        response: oneshot::Sender<bool>,
    },
    Broadcast {
        payload: Digest,
        plan: Plan<PublicKey>,
    },
    Finalized {
        payload: Digest,
        view: u64,
    },
    Submit {
        tx: Tx,
        reply: oneshot::Sender<peal_bonsai::Result<Applied>>,
        timeout: Duration,
    },
    Status {
        reply: oneshot::Sender<Status>,
    },
    Gather {
        body: Vec<u8>,
        min: usize,
        timeout: Duration,
        reply: oneshot::Sender<Vec<(PublicKey, Vec<u8>)>>,
    },
    GatherTimeout {
        id: u64,
    },
    Net {
        channel: u64,
        from: PublicKey,
        bytes: Vec<u8>,
    },
    /// Outcome of an admission task: the transaction passed every check
    /// (for mints, including this validator's own deposit confirmation) and
    /// may enter the mempool, or it did not.
    Admission {
        admitted: Option<(Tx, Option<SubmitWaiter>, bool)>,
    },
    /// A finalized block was applied off the actor task.
    Applied {
        id: Id,
        cached: Arc<Cached>,
        results: Result<Vec<peal_bonsai::Result<Applied>>, String>,
    },
    /// Forget a transaction this validator will not vote for.
    Drop {
        id: Id,
    },
    /// Build the block now, after the idle wait.
    ProposeNow {
        context: Ctx,
        response: oneshot::Sender<Digest>,
    },
    Tick,
}

/// The engine-facing and node-facing handle: a clone of the actor's
/// mailbox.
#[derive(Clone)]
pub struct Mailbox {
    tx: mpsc::UnboundedSender<Message>,
}

impl Mailbox {
    pub fn send(&self, m: Message) -> bool {
        self.tx.send(m).is_ok()
    }
}

impl Automaton for Mailbox {
    type Context = Ctx;
    type Digest = Digest;

    async fn propose(&mut self, context: Ctx) -> oneshot::Receiver<Digest> {
        let (response, rx) = oneshot::channel();
        let _ = self.tx.send(Message::Propose { context, response });
        rx
    }

    async fn verify(&mut self, context: Ctx, payload: Digest) -> oneshot::Receiver<bool> {
        let (response, rx) = oneshot::channel();
        let _ = self.tx.send(Message::Verify {
            context,
            payload,
            response,
        });
        rx
    }
}

/// Certification uses the library default (always `true`): every check a
/// validator makes happens in `verify`, before the vote; there is no second
/// application-level gate after notarization.
impl CertifiableAutomaton for Mailbox {}

impl Relay for Mailbox {
    type Digest = Digest;
    type PublicKey = PublicKey;
    type Plan = Plan<PublicKey>;

    fn broadcast(&mut self, payload: Digest, plan: Plan<PublicKey>) -> Feedback {
        if self.tx.send(Message::Broadcast { payload, plan }).is_ok() {
            Feedback::Ok
        } else {
            Feedback::Closed
        }
    }
}

impl Reporter for Mailbox {
    type Activity = Activity<Scheme, Digest>;

    fn report(&mut self, activity: Self::Activity) -> Feedback {
        if let Activity::Finalization(f) = activity {
            let _ = self.tx.send(Message::Finalized {
                payload: f.proposal.payload,
                view: f.proposal.round.view().get(),
            });
        }
        Feedback::Ok
    }
}

/// The node-facing handle.
#[derive(Clone)]
pub struct Handle {
    mailbox: Mailbox,
    pub me: PublicKey,
    pub validators: Vec<PublicKey>,
}

impl Handle {
    /// Submit a transaction and wait until a finalized block applied it
    /// (or rejected it). `timeout` bounds the wait; consensus that makes
    /// no progress answers with a storage error, never a fake success.
    pub async fn submit(&self, tx: Tx, timeout: Duration) -> peal_bonsai::Result<Applied> {
        let (reply, rx) = oneshot::channel();
        if !self.mailbox.send(Message::Submit { tx, reply, timeout }) {
            return Err(peal_bonsai::Error::Storage(
                "consensus is not running".into(),
            ));
        }
        // The actor enforces the deadline with its own clock, so this works
        // on the live and the deterministic runtime alike.
        rx.await.unwrap_or_else(|_| {
            Err(peal_bonsai::Error::Storage(
                "consensus dropped the submission".into(),
            ))
        })
    }

    pub async fn status(&self) -> Option<Status> {
        let (reply, rx) = oneshot::channel();
        self.mailbox.send(Message::Status { reply });
        rx.await.ok()
    }

    /// Send `body` to every other validator and collect answers until
    /// `min` arrived or `timeout` passed.
    pub async fn gather(
        &self,
        body: Vec<u8>,
        min: usize,
        timeout: Duration,
    ) -> Vec<(PublicKey, Vec<u8>)> {
        let (reply, rx) = oneshot::channel();
        self.mailbox.send(Message::Gather {
            body,
            min,
            timeout,
            reply,
        });
        rx.await.unwrap_or_default()
    }
}

pub struct Cached {
    block: Block,
    bytes: Vec<u8>,
}

struct PoolEntry {
    id: Id,
    tx: Tx,
    bytes: Vec<u8>,
    added: SystemTime,
}

struct Waiter {
    reply: oneshot::Sender<peal_bonsai::Result<Applied>>,
    expires: SystemTime,
}

struct Gather {
    reply: oneshot::Sender<Vec<(PublicKey, Vec<u8>)>>,
    responses: Vec<(PublicKey, Vec<u8>)>,
    min: usize,
}

pub struct Config<S> {
    pub me: PublicKey,
    pub validators: Vec<PublicKey>,
    pub genesis: Id,
    pub state: Shared,
    pub oracle: Arc<dyn DepositOracle>,
    pub app: Arc<dyn AppHandler>,
    pub blocks_out: S,
    pub txs_out: S,
    pub app_out: S,
    pub max_block_txs: usize,
    /// How long a transaction may wait in the mempool before its
    /// submitter is told consensus did not include it.
    pub mempool_ttl: Duration,
}

pub struct Actor<E, S> {
    context: E,
    cfg: Config<S>,
    mailbox: mpsc::UnboundedReceiver<Message>,
    self_tx: mpsc::UnboundedSender<Message>,
    head: Head,
    blocks: HashMap<Id, Arc<Cached>>,
    /// Verifications waiting for the block's bytes.
    verify_waiters: HashMap<Id, Vec<(Ctx, oneshot::Sender<bool>)>>,
    /// Blocks whose verification waits for their parent (child ids by parent id).
    parent_waiters: HashMap<Id, Vec<Id>>,
    requested: HashMap<Id, SystemTime>,
    /// When a digest first went into `verify_waiters` or `parent_waiters`,
    /// so a block nobody can supply is given up on.
    waiting_since: HashMap<Id, SystemTime>,
    mempool: Vec<PoolEntry>,
    mempool_ids: HashSet<Id>,
    mempool_bytes: usize,
    admissions_in_flight: usize,
    /// A finalized block is being applied off the actor task.
    applying: bool,
    waiters: HashMap<Id, Vec<Waiter>>,
    finalized_known: BTreeMap<u64, Id>,
    finalized_unknown: HashSet<Id>,
    finalized_seen: u64,
    last_finalized_view: u64,
    gathers: HashMap<u64, Gather>,
    next_gather: u64,
}

/// Feed a network receiver into the mailbox until it closes.
pub fn pump<E, R>(context: &E, channel: u64, mut rx: R, mailbox: Mailbox)
where
    E: Spawner + Supervisor,
    R: commonware_p2p::Receiver<PublicKey = PublicKey>,
{
    context.child("pump").spawn(move |_| async move {
        loop {
            match rx.recv().await {
                Ok((from, buf)) => {
                    if !mailbox.send(Message::Net {
                        channel,
                        from,
                        bytes: buf.as_ref().to_vec(),
                    }) {
                        break;
                    }
                }
                Err(e) => {
                    warn!(channel, error = ?e, "network receiver closed");
                    break;
                }
            }
        }
    });
}

const REQUEST_RETRY: Duration = Duration::from_millis(500);
const IDLE_PROPOSE_DELAY: Duration = Duration::from_millis(400);
/// Applied blocks kept in memory behind the head (the rest are served from
/// the block store).
const BLOCK_CACHE_BEHIND: u64 = 64;
/// How far ahead of the head an unsolicited block may be to be cached.
const BLOCK_WINDOW_AHEAD: u64 = 256;
/// Hard cap on cached blocks, whatever their heights.
const MAX_BLOCK_CACHE: usize = 4_096;
const MAX_MEMPOOL_TXS: usize = 4_096;
const MAX_MEMPOOL_BYTES: usize = 32 * 1024 * 1024;
/// Admission checks (a proof verification each, plus an RPC round trip for
/// mints) running concurrently; peers past this are dropped.
const MAX_ADMISSIONS_IN_FLIGHT: usize = 64;
/// How long to keep asking peers for a block before giving up on it.
const WAIT_TTL: Duration = Duration::from_secs(10);

impl<E, S> Actor<E, S>
where
    E: Clock + Spawner + Metrics + Supervisor + Send + Sync + 'static,
    S: Sender<PublicKey = PublicKey> + Clone,
{
    pub fn new(context: E, cfg: Config<S>) -> (Self, Mailbox) {
        let (tx, rx) = mpsc::unbounded_channel();
        let head = lock(&cfg.state).head();
        let actor = Self {
            context,
            cfg,
            mailbox: rx,
            self_tx: tx.clone(),
            head,
            blocks: HashMap::new(),
            verify_waiters: HashMap::new(),
            parent_waiters: HashMap::new(),
            requested: HashMap::new(),
            waiting_since: HashMap::new(),
            mempool: Vec::new(),
            mempool_ids: HashSet::new(),
            mempool_bytes: 0,
            admissions_in_flight: 0,
            applying: false,
            waiters: HashMap::new(),
            finalized_known: BTreeMap::new(),
            finalized_unknown: HashSet::new(),
            finalized_seen: 0,
            last_finalized_view: 0,
            gathers: HashMap::new(),
            next_gather: 1,
        };
        (actor, Mailbox { tx })
    }

    pub fn handle(&self) -> Handle {
        Handle {
            mailbox: Mailbox {
                tx: self.self_tx.clone(),
            },
            me: self.cfg.me.clone(),
            validators: self.cfg.validators.clone(),
        }
    }

    pub async fn run(mut self) {
        // Housekeeping tick.
        {
            let tick = self.self_tx.clone();
            self.context.child("tick").spawn(move |ctx| async move {
                loop {
                    ctx.sleep(Duration::from_millis(250)).await;
                    if tick.send(Message::Tick).is_err() {
                        break;
                    }
                }
            });
        }
        let mut stopped = std::pin::pin!(self.context.stopped());
        loop {
            tokio::select! {
                biased;
                _ = &mut stopped => {
                    debug!("consensus actor stopping");
                    break;
                }
                msg = self.mailbox.recv() => {
                    let Some(msg) = msg else { break };
                    self.on_message(msg);
                }
            }
        }
    }

    fn on_message(&mut self, msg: Message) {
        match msg {
            Message::Propose { context, response } => {
                if self.mempool.is_empty() {
                    // Nothing to order: wait a little before proposing an
                    // empty block, so an idle chain advances a few times a
                    // second rather than as fast as the engine can turn.
                    let back = self.self_tx.clone();
                    self.context.child("idle").spawn(move |ctx| async move {
                        ctx.sleep(IDLE_PROPOSE_DELAY).await;
                        let _ = back.send(Message::ProposeNow { context, response });
                    });
                } else {
                    self.on_propose(context, response)
                }
            }
            Message::ProposeNow { context, response } => self.on_propose(context, response),
            Message::Verify {
                context,
                payload,
                response,
            } => self.on_verify(context, payload.0, response),
            Message::Broadcast { payload, plan } => self.on_broadcast(payload.0, plan),
            Message::Finalized { payload, view } => self.on_finalized(payload.0, view),
            Message::Submit { tx, reply, timeout } => self.on_submit(tx, reply, timeout),
            Message::Status { reply } => {
                let _ = reply.send(self.status());
            }
            Message::Gather {
                body,
                min,
                timeout,
                reply,
            } => self.on_gather(body, min, timeout, reply),
            Message::GatherTimeout { id } => {
                if let Some(g) = self.gathers.remove(&id) {
                    let _ = g.reply.send(g.responses);
                }
            }
            Message::Net {
                channel,
                from,
                bytes,
            } => self.on_net(channel, from, bytes),
            Message::Admission { admitted } => {
                self.admissions_in_flight = self.admissions_in_flight.saturating_sub(1);
                if let Some((tx, waiter, gossip)) = admitted {
                    self.on_admitted(tx, waiter, gossip);
                }
            }
            Message::Applied {
                id,
                cached,
                results,
            } => self.on_applied(id, cached, results),
            Message::Drop { id } => {
                // This validator will not propose the mint; the submitter's
                // waiter stays, because a quorum may still finalize it (the
                // other validators' chain views are theirs) and the answer
                // must be what the ledger did, not what this node guessed.
                self.remove_from_mempool(&id);
            }
            Message::Tick => self.on_tick(),
        }
    }

    // ---- proposing -----------------------------------------------------------

    fn parent_height(&self, parent: &Id) -> Option<u64> {
        if *parent == self.cfg.genesis {
            return Some(0);
        }
        if *parent == self.head.digest {
            return Some(self.head.height);
        }
        if let Some(b) = self.blocks.get(parent) {
            return Some(b.block.height);
        }
        lock(&self.cfg.state).block_height(parent)
    }

    fn on_propose(&mut self, context: Ctx, response: oneshot::Sender<Digest>) {
        let parent = context.parent.1 .0;
        let Some(parent_height) = self.parent_height(&parent) else {
            warn!(
                parent = hex::encode(parent),
                "asked to propose on an unknown parent"
            );
            self.request(parent);
            return;
        };
        // Transactions already included in the unapplied ancestor chain.
        let mut excluded: HashSet<Id> = HashSet::new();
        let mut cur = parent;
        while cur != self.head.digest && cur != self.cfg.genesis {
            match self.blocks.get(&cur) {
                Some(b) => {
                    excluded.extend(b.block.tx_ids());
                    cur = b.block.parent;
                }
                None => break,
            }
        }
        let mut txs = Vec::new();
        let mut size = 256usize;
        let max_txs = self.cfg.max_block_txs.min(crate::block::MAX_BLOCK_TXS);
        for e in &self.mempool {
            if txs.len() >= max_txs {
                break;
            }
            if excluded.contains(&e.id) {
                continue;
            }
            let len = e.bytes.len() + 2;
            if size + len > MAX_BLOCK_BYTES {
                break;
            }
            size += len;
            txs.push(e.tx.clone());
        }
        let block = Block {
            version: crate::block::VERSION,
            epoch: context.round.epoch().get(),
            view: context.round.view().get(),
            height: parent_height + 1,
            parent,
            txs,
        };
        let bytes = block.encode();
        let id = Block::digest_of(&bytes);
        debug!(
            height = block.height,
            txs = block.txs.len(),
            digest = hex::encode(id),
            "proposing block"
        );
        self.blocks.insert(id, Arc::new(Cached { block, bytes }));
        let _ = response.send(Digest(id));
    }

    fn on_broadcast(&mut self, payload: Id, plan: Plan<PublicKey>) {
        let Some(cached) = self.blocks.get(&payload) else {
            warn!(
                digest = hex::encode(payload),
                "asked to broadcast an unknown block"
            );
            return;
        };
        let msg = BlockWire::Block(cached.bytes.clone()).encode();
        let recipients = match plan {
            Plan::Propose { .. } => Recipients::All,
            Plan::Forward { recipients, .. } => recipients,
        };
        self.cfg.blocks_out.send(recipients, msg, true);
    }

    // ---- verifying -----------------------------------------------------------

    fn on_verify(&mut self, context: Ctx, id: Id, response: oneshot::Sender<bool>) {
        let Some(cached) = self.blocks.get(&id).cloned() else {
            let now = self.context.current();
            self.waiting_since.entry(id).or_insert(now);
            self.verify_waiters
                .entry(id)
                .or_default()
                .push((context, response));
            self.request(id);
            return;
        };
        let block = &cached.block;
        let Some(parent_height) = self.parent_height(&block.parent) else {
            let now = self.context.current();
            self.waiting_since.entry(block.parent).or_insert(now);
            self.waiting_since.entry(id).or_insert(now);
            self.parent_waiters
                .entry(block.parent)
                .or_default()
                .push(id);
            self.verify_waiters
                .entry(id)
                .or_default()
                .push((context, response));
            self.request(block.parent);
            return;
        };
        let structural = block.epoch == context.round.epoch().get()
            && block.view == context.round.view().get()
            && block.parent == context.parent.1 .0
            && block.height == parent_height + 1;
        if !structural {
            warn!(
                digest = hex::encode(id),
                height = block.height,
                view = block.view,
                "block does not match its consensus context; voting against it"
            );
            let _ = response.send(false);
            return;
        }
        let state = self.cfg.state.clone();
        let oracle = self.cfg.oracle.clone();
        let back = self.self_tx.clone();
        self.context.child("verify").spawn(move |ctx| async move {
            let stateless = lock(&state).check_block(&cached.block);
            if let Err(e) = stateless {
                warn!(digest = hex::encode(id), error = e, "block fails stateless checks");
                let _ = response.send(false);
                return;
            }
            // Mints: this validator's own chain view must confirm the deposit.
            for tx in &cached.block.txs {
                if let Envelope::Mint(env) = &tx.envelope {
                    let mut attempts = 0;
                    loop {
                        match oracle.confirmed(tx.namespace, env.clone()).await {
                            Ok(true) => break,
                            Ok(false) => {
                                warn!(
                                    deposit_id = env.deposit_id,
                                    "proposed mint is not confirmed on this validator's chain view; voting against"
                                );
                                let _ = back.send(Message::Drop { id: tx.id() });
                                let _ = response.send(false);
                                return;
                            }
                            Err(e) => {
                                attempts += 1;
                                if attempts >= 3 {
                                    warn!(deposit_id = env.deposit_id, error = e, "chain unreachable; abstaining");
                                    // Abstain: a dropped sender is an ignored
                                    // proposal to the engine, never a vote.
                                    drop(response);
                                    return;
                                }
                                ctx.sleep(Duration::from_millis(300)).await;
                            }
                        }
                    }
                }
            }
            let _ = response.send(true);
        });
    }

    /// A block's bytes became available: retry everything that waited.
    fn on_block_available(&mut self, id: Id) {
        self.requested.remove(&id);
        self.waiting_since.remove(&id);
        if let Some(waiters) = self.verify_waiters.remove(&id) {
            for (context, response) in waiters {
                self.on_verify(context, id, response);
            }
        }
        if let Some(children) = self.parent_waiters.remove(&id) {
            for child in children {
                if let Some(waiters) = self.verify_waiters.remove(&child) {
                    for (context, response) in waiters {
                        self.on_verify(context, child, response);
                    }
                }
            }
        }
        if self.finalized_unknown.remove(&id) {
            if let Some(b) = self.blocks.get(&id) {
                self.finalized_known.insert(b.block.height, id);
            }
        }
        self.drain_finalized();
    }

    fn request(&mut self, id: Id) {
        let now = self.context.current();
        if let Some(t) = self.requested.get(&id) {
            if now.duration_since(*t).unwrap_or_default() < REQUEST_RETRY {
                return;
            }
        }
        self.requested.insert(id, now);
        self.cfg
            .blocks_out
            .send(Recipients::All, BlockWire::Request(id).encode(), true);
    }

    // ---- finalizing ----------------------------------------------------------

    fn on_finalized(&mut self, id: Id, view: u64) {
        self.finalized_seen += 1;
        self.last_finalized_view = self.last_finalized_view.max(view);
        if id == self.cfg.genesis {
            return;
        }
        match self.blocks.get(&id) {
            Some(b) => {
                self.finalized_known.insert(b.block.height, id);
            }
            None => {
                if self.finalized_unknown.insert(id) {
                    self.request(id);
                }
            }
        }
        self.drain_finalized();
    }

    fn drain_finalized(&mut self) {
        while let Some((&height, &id)) = self.finalized_known.first_key_value() {
            if height <= self.head.height {
                // Already applied (or a re-report). A different digest at an
                // applied height would be a safety violation: say so loudly.
                if height == self.head.height && id != self.head.digest {
                    error!(
                        height,
                        finalized = hex::encode(id),
                        applied = hex::encode(self.head.digest),
                        "finalized block conflicts with the applied chain"
                    );
                }
                self.finalized_known.remove(&height);
                continue;
            }
            if height == self.head.height + 1 {
                let Some(cached) = self.blocks.get(&id).cloned() else {
                    // Marked finalized through a descendant but not fetched yet.
                    self.request(id);
                    break;
                };
                if cached.block.parent != self.head.digest {
                    error!(
                        height,
                        digest = hex::encode(id),
                        "finalized block does not extend the applied head; dropping it"
                    );
                    self.finalized_known.remove(&height);
                    continue;
                }
                if self.applying {
                    // One block at a time, in order; `on_applied` resumes.
                    break;
                }
                self.applying = true;
                let state = self.cfg.state.clone();
                let back = self.self_tx.clone();
                self.context.child("apply").spawn(move |_| async move {
                    let results = lock(&state).apply_block(&cached.block, &cached.bytes, id);
                    let _ = back.send(Message::Applied {
                        id,
                        cached,
                        results,
                    });
                });
                break;
            }
            // A gap: walk the parent chain down to the head, marking every
            // known ancestor as finalized and requesting the first unknown.
            let mut cur = id;
            let mut progressed = false;
            loop {
                let Some(b) = self.blocks.get(&cur).cloned() else {
                    self.request(cur);
                    break;
                };
                if b.block.height <= self.head.height + 1 {
                    if b.block.height == self.head.height + 1 {
                        progressed |= self.finalized_known.insert(b.block.height, cur).is_none();
                    }
                    break;
                }
                let parent = b.block.parent;
                let parent_height = b.block.height - 1;
                if self.finalized_known.insert(parent_height, parent).is_none() {
                    progressed = true;
                }
                cur = parent;
            }
            if !progressed {
                break;
            }
        }
    }

    fn on_applied(
        &mut self,
        id: Id,
        cached: Arc<Cached>,
        results: Result<Vec<peal_bonsai::Result<Applied>>, String>,
    ) {
        self.applying = false;
        self.finalized_known.remove(&cached.block.height);
        match results {
            Err(e) => {
                error!(error = e, "applying a finalized block failed");
            }
            Ok(results) => {
                let head = lock(&self.cfg.state).head();
                self.head = head;
                let ok = results.iter().filter(|r| r.is_ok()).count();
                if results.is_empty() {
                    debug!(
                        height = head.height,
                        digest = hex::encode(id),
                        "empty block applied"
                    );
                } else {
                    info!(
                        height = head.height,
                        digest = hex::encode(id),
                        txs = results.len(),
                        accepted = ok,
                        state_root = hex::encode(head.root),
                        "block finalized and applied"
                    );
                }
                for (tx, result) in cached.block.txs.iter().zip(results) {
                    let tx_id = tx.id();
                    self.remove_from_mempool(&tx_id);
                    if let Some(waiters) = self.waiters.remove(&tx_id) {
                        // The same result for every waiter: errors are cloned
                        // by message since `Error` is not `Clone`.
                        let mut waiters = waiters.into_iter();
                        if let Some(first) = waiters.next() {
                            let rest: Vec<_> = waiters.collect();
                            match result {
                                Ok(applied) => {
                                    for w in rest {
                                        let _ = w.reply.send(Ok(applied.clone()));
                                    }
                                    let _ = first.reply.send(Ok(applied));
                                }
                                Err(e) => {
                                    for w in rest {
                                        let _ = w
                                            .reply
                                            .send(Err(peal_bonsai::Error::Storage(e.to_string())));
                                    }
                                    let _ = first.reply.send(Err(e));
                                }
                            }
                        }
                    }
                }
                self.prune_blocks();
            }
        }
        self.drain_finalized();
    }

    /// Applied blocks leave memory a little behind the head (the store
    /// serves them to peers); the cache never grows past its cap.
    fn prune_blocks(&mut self) {
        let floor = self.head.height.saturating_sub(BLOCK_CACHE_BEHIND);
        self.blocks.retain(|_, b| b.block.height >= floor);
        if self.blocks.len() > MAX_BLOCK_CACHE {
            let head = self.head.height;
            self.blocks.retain(|_, b| b.block.height > head);
        }
    }

    /// Whether a block a peer sent unasked is worth caching: close ahead
    /// of the head (a proposal in flight) or explicitly wanted.
    fn wants_block(&self, id: &Id, height: u64) -> bool {
        if self.requested.contains_key(id)
            || self.verify_waiters.contains_key(id)
            || self.finalized_unknown.contains(id)
        {
            return true;
        }
        height > self.head.height
            && height <= self.head.height + BLOCK_WINDOW_AHEAD
            && self.blocks.len() < MAX_BLOCK_CACHE
    }

    // ---- mempool -------------------------------------------------------------

    fn remove_from_mempool(&mut self, id: &Id) {
        if self.mempool_ids.remove(id) {
            if let Some(i) = self.mempool.iter().position(|e| &e.id == id) {
                let e = self.mempool.remove(i);
                self.mempool_bytes = self.mempool_bytes.saturating_sub(e.bytes.len());
            }
        }
    }

    fn on_submit(
        &mut self,
        tx: Tx,
        reply: oneshot::Sender<peal_bonsai::Result<Applied>>,
        timeout: Duration,
    ) {
        self.admit(tx, Some((reply, timeout)), true);
    }

    fn on_peer_tx(&mut self, from: &PublicKey, bytes: &[u8]) {
        let tx = match Tx::decode(bytes) {
            Ok(tx) => tx,
            Err(e) => {
                warn!(peer = %from, error = e, "undecodable transaction from peer");
                return;
            }
        };
        if self.mempool_ids.contains(&tx.id()) {
            return;
        }
        self.admit(tx, None, false);
    }

    /// Stateless checks now; for a mint, this validator's own deposit
    /// confirmation before the transaction can be proposed. A proposer
    /// therefore never includes a mint its own chain view has not
    /// confirmed, and a verifier's check is the safety net.
    fn admit(&mut self, tx: Tx, waiter: Option<SubmitWaiter>, gossip: bool) {
        // The checks cost a proof verification each (and an RPC round trip
        // for a mint), so they run off the actor task and only so many at
        // once: a peer cannot make this validator verify at its pace.
        if self.admissions_in_flight >= MAX_ADMISSIONS_IN_FLIGHT {
            if let Some((reply, _)) = waiter {
                let _ = reply.send(Err(peal_bonsai::Error::Storage(
                    "validator is busy admitting operations; retry".into(),
                )));
            }
            return;
        }
        if self.mempool.len() >= MAX_MEMPOOL_TXS {
            if let Some((reply, _)) = waiter {
                let _ = reply.send(Err(peal_bonsai::Error::Storage(
                    "mempool is full; retry".into(),
                )));
            }
            return;
        }
        self.admissions_in_flight += 1;
        let state = self.cfg.state.clone();
        let oracle = self.cfg.oracle.clone();
        let back = self.self_tx.clone();
        self.context.child("admit").spawn(move |_| async move {
            let checked = lock(&state).check_tx(&tx);
            if let Err(e) = checked {
                if let Some((reply, _)) = waiter {
                    let _ = reply.send(Err(e));
                }
                let _ = back.send(Message::Admission { admitted: None });
                return;
            }
            if let Envelope::Mint(env) = &tx.envelope {
                match oracle.confirmed(tx.namespace, env.clone()).await {
                    Ok(true) => {}
                    Ok(false) => {
                        if let Some((reply, _)) = waiter {
                            let _ = reply.send(Err(peal_bonsai::Error::Storage(
                                "deposit is not confirmed on this validator's chain view".into(),
                            )));
                        }
                        let _ = back.send(Message::Admission { admitted: None });
                        return;
                    }
                    Err(e) => {
                        if let Some((reply, _)) = waiter {
                            let _ = reply.send(Err(peal_bonsai::Error::Storage(format!(
                                "chain unreachable while confirming the deposit: {e}"
                            ))));
                        }
                        let _ = back.send(Message::Admission { admitted: None });
                        return;
                    }
                }
            }
            let _ = back.send(Message::Admission {
                admitted: Some((tx, waiter, gossip)),
            });
        });
    }

    fn on_admitted(&mut self, tx: Tx, waiter: Option<SubmitWaiter>, gossip: bool) {
        let id = tx.id();
        if let Some((reply, timeout)) = waiter {
            let expires = self.context.current() + timeout;
            self.waiters
                .entry(id)
                .or_default()
                .push(Waiter { reply, expires });
        }
        if self.mempool_ids.contains(&id) {
            return;
        }
        let bytes = tx.encode();
        if self.mempool.len() >= MAX_MEMPOOL_TXS
            || self.mempool_bytes + bytes.len() > MAX_MEMPOOL_BYTES
        {
            if let Some(waiters) = self.waiters.remove(&id) {
                for w in waiters {
                    let _ = w.reply.send(Err(peal_bonsai::Error::Storage(
                        "mempool is full; retry".into(),
                    )));
                }
            }
            return;
        }
        self.mempool_ids.insert(id);
        self.mempool_bytes += bytes.len();
        if gossip {
            self.cfg.txs_out.send(Recipients::All, bytes.clone(), false);
        }
        self.mempool.push(PoolEntry {
            id,
            tx,
            bytes,
            added: self.context.current(),
        });
    }

    fn on_tick(&mut self) {
        let now = self.context.current();
        // Expire transactions consensus never included.
        let ttl = self.cfg.mempool_ttl;
        let expired: Vec<Id> = self
            .mempool
            .iter()
            .filter(|e| now.duration_since(e.added).unwrap_or_default() > ttl)
            .map(|e| e.id)
            .collect();
        for id in expired {
            self.remove_from_mempool(&id);
            if let Some(waiters) = self.waiters.remove(&id) {
                for w in waiters {
                    let _ = w.reply.send(Err(peal_bonsai::Error::Storage(
                        "consensus did not include the operation in time".into(),
                    )));
                }
            }
        }
        // Submitters whose own deadline passed.
        for waiters in self.waiters.values_mut() {
            let mut kept = Vec::with_capacity(waiters.len());
            for w in waiters.drain(..) {
                if w.expires <= now {
                    let _ = w.reply.send(Err(peal_bonsai::Error::Storage(
                        "consensus did not finalize the operation in time".into(),
                    )));
                } else {
                    kept.push(w);
                }
            }
            *waiters = kept;
        }
        self.waiters.retain(|_, w| !w.is_empty());
        // Give up on blocks nobody supplied (a proposal with a parent no
        // one holds): the vote is abstained by dropping its sender, and the
        // request stops. Blocks known to be finalized are still wanted.
        let stale: Vec<Id> = self
            .waiting_since
            .iter()
            .filter(|(_, t)| now.duration_since(**t).unwrap_or_default() > WAIT_TTL)
            .map(|(id, _)| *id)
            .collect();
        for id in stale {
            self.waiting_since.remove(&id);
            self.verify_waiters.remove(&id);
            self.parent_waiters.remove(&id);
            if !self.finalized_unknown.contains(&id) {
                self.requested.remove(&id);
            }
        }
        // Re-request blocks we still need.
        let wanted: Vec<Id> = self
            .verify_waiters
            .keys()
            .chain(self.parent_waiters.keys())
            .chain(self.finalized_unknown.iter())
            .copied()
            .collect();
        for id in wanted {
            if !self.blocks.contains_key(&id) {
                self.request(id);
            }
        }
    }

    // ---- network -------------------------------------------------------------

    fn on_net(&mut self, channel: u64, from: PublicKey, bytes: Vec<u8>) {
        match channel {
            CH_BLOCKS => match BlockWire::decode(&bytes) {
                Ok(BlockWire::Block(raw)) => {
                    let id = Block::digest_of(&raw);
                    if self.blocks.contains_key(&id) {
                        return;
                    }
                    match Block::decode(&raw) {
                        Ok(block) => {
                            if !self.wants_block(&id, block.height) {
                                debug!(peer = %from, height = block.height, "ignoring an unwanted block");
                                return;
                            }
                            self.blocks
                                .insert(id, Arc::new(Cached { block, bytes: raw }));
                            self.on_block_available(id);
                        }
                        Err(e) => warn!(peer = %from, error = e, "undecodable block from peer"),
                    }
                }
                Ok(BlockWire::Request(id)) => {
                    let bytes = match self.blocks.get(&id) {
                        Some(b) => Some(b.bytes.clone()),
                        None => lock(&self.cfg.state).block_bytes(&id),
                    };
                    if let Some(bytes) = bytes {
                        self.cfg.blocks_out.send(
                            Recipients::One(from),
                            BlockWire::Block(bytes).encode(),
                            true,
                        );
                    }
                }
                Err(e) => warn!(peer = %from, error = e, "bad block message"),
            },
            CH_TXS => self.on_peer_tx(&from, &bytes),
            CH_APP => match AppWire::decode(&bytes) {
                Ok(AppWire::Request { id, body }) => {
                    let app = self.cfg.app.clone();
                    let mut out = self.cfg.app_out.clone();
                    self.context.child("app").spawn(move |_| async move {
                        if let Some(answer) = app.handle(from.clone(), body).await {
                            out.send(
                                Recipients::One(from),
                                AppWire::Response { id, body: answer }.encode(),
                                false,
                            );
                        }
                    });
                }
                Ok(AppWire::Response { id, body }) => {
                    let done = match self.gathers.get_mut(&id) {
                        Some(g) => {
                            if !g.responses.iter().any(|(p, _)| *p == from) {
                                g.responses.push((from, body));
                            }
                            g.responses.len() >= g.min
                        }
                        None => false,
                    };
                    if done {
                        if let Some(g) = self.gathers.remove(&id) {
                            let _ = g.reply.send(g.responses);
                        }
                    }
                }
                Err(e) => warn!(peer = %from, error = e, "bad application message"),
            },
            other => warn!(channel = other, "message on an unexpected channel"),
        }
    }

    fn on_gather(
        &mut self,
        body: Vec<u8>,
        min: usize,
        timeout: Duration,
        reply: oneshot::Sender<Vec<(PublicKey, Vec<u8>)>>,
    ) {
        let id = self.next_gather;
        self.next_gather += 1;
        self.gathers.insert(
            id,
            Gather {
                reply,
                responses: Vec::new(),
                min: min.max(1),
            },
        );
        self.cfg.app_out.send(
            Recipients::All,
            AppWire::Request { id, body }.encode(),
            false,
        );
        let tick = self.self_tx.clone();
        self.context.child("gather").spawn(move |ctx| async move {
            ctx.sleep(timeout).await;
            let _ = tick.send(Message::GatherTimeout { id });
        });
    }

    fn status(&self) -> Status {
        Status {
            validator: self.cfg.me.to_string(),
            validators: self.cfg.validators.iter().map(|v| v.to_string()).collect(),
            height: self.head.height,
            head: hex::encode(self.head.digest),
            state_root: hex::encode(self.head.root),
            genesis: hex::encode(self.cfg.genesis),
            mempool: self.mempool.len(),
            finalized_seen: self.finalized_seen,
            last_finalized_view: self.last_finalized_view,
            blocks_cached: self.blocks.len(),
            pending_finalized: self.finalized_known.len() + self.finalized_unknown.len(),
        }
    }
}
