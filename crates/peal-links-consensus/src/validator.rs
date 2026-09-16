//! A live validator: the Commonware tokio runtime, authenticated
//! discovery p2p between the configured validators, the engine and the
//! application actor, all on a thread of their own. The node keeps its
//! own tokio runtime and talks to the validator through `Handle`.

use std::net::SocketAddr;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use commonware_p2p::authenticated::discovery;
use commonware_p2p::authenticated::peer_set_limit;
use commonware_p2p::Manager;
use commonware_runtime::tokio as rt;
use commonware_runtime::{Quota, Runner, Spawner, Supervisor};
use commonware_utils::ordered::Set;

use crate::actor::{pump, Actor, AppHandler, Config as ActorConfig, DepositOracle, Handle};
use crate::block::Id;
use crate::engine::{self, Params};
use crate::state::Shared;
use crate::wire::{CH_APP, CH_BLOCKS, CH_CERTIFICATE, CH_RESOLVER, CH_TXS, CH_VOTE};
use crate::{PrivateKey, PublicKey};

const MAX_MESSAGE_SIZE: u32 = 1024 * 1024;

pub struct ValidatorConfig {
    pub private_key: PrivateKey,
    pub validators: Vec<PublicKey>,
    pub listen: SocketAddr,
    /// The other validators' addresses (this validator's own entry is
    /// ignored).
    pub peers: Vec<(PublicKey, SocketAddr)>,
    /// Where the engine keeps its journal.
    pub storage_dir: PathBuf,
    pub genesis: Id,
    pub params: Params,
    pub max_block_txs: usize,
    pub mempool_ttl: Duration,
    pub worker_threads: usize,
}

/// Start a validator on its own thread. Returns once the actor's handle
/// exists; consensus runs until the process ends.
pub fn start(
    cfg: ValidatorConfig,
    state: Shared,
    oracle: Arc<dyn DepositOracle>,
    app: Arc<dyn AppHandler>,
) -> anyhow::Result<Handle> {
    let me = commonware_cryptography::Signer::public_key(&cfg.private_key);
    let set: Set<PublicKey> = Set::from_iter_dedup(cfg.validators.iter().cloned());
    let scheme = engine::scheme(&cfg.genesis, &set, &cfg.private_key)
        .ok_or_else(|| anyhow::anyhow!("this validator's key is not in the validator set"))?;
    let (handle_tx, handle_rx) = std::sync::mpsc::channel::<Handle>();
    std::fs::create_dir_all(&cfg.storage_dir)?;
    let runtime_cfg = rt::Config::new()
        .with_storage_directory(cfg.storage_dir.clone())
        .with_worker_threads(cfg.worker_threads.max(2));
    std::thread::Builder::new()
        .name("peal-links-consensus".into())
        .spawn(move || {
            let executor = rt::Runner::new(runtime_cfg);
            executor.start(|context| async move {
                let bootstrappers: Vec<discovery::Bootstrapper<PublicKey>> = cfg
                    .peers
                    .iter()
                    .filter(|(pk, _)| *pk != me)
                    .map(|(pk, addr)| (pk.clone(), (*addr).into()))
                    .collect();
                let p2p_cfg = discovery::Config::local(
                    cfg.private_key.clone(),
                    &engine::p2p_namespace(&cfg.genesis),
                    cfg.listen,
                    cfg.listen,
                    bootstrappers,
                    peer_set_limit(set.iter(), &me),
                    MAX_MESSAGE_SIZE,
                );
                let (mut network, mut oracle_p2p) =
                    discovery::Network::new(context.child("network"), p2p_cfg);
                oracle_p2p.track(0, set.clone());
                let quota = |n: u32| Quota::per_second(NonZeroU32::new(n).expect("non-zero"));
                let vote = network.register(CH_VOTE, quota(128));
                let cert = network.register(CH_CERTIFICATE, quota(128));
                let resolver = network.register(CH_RESOLVER, quota(128));
                let (blocks_s, blocks_r) = network.register(CH_BLOCKS, quota(256));
                let (txs_s, txs_r) = network.register(CH_TXS, quota(1024));
                let (app_s, app_r) = network.register(CH_APP, quota(128));
                let (actor, mailbox) = Actor::new(
                    context.child("application"),
                    ActorConfig {
                        me: me.clone(),
                        validators: cfg.validators.clone(),
                        genesis: cfg.genesis,
                        state,
                        oracle,
                        app,
                        blocks_out: blocks_s,
                        txs_out: txs_s,
                        app_out: app_s,
                        max_block_txs: cfg.max_block_txs,
                        mempool_ttl: cfg.mempool_ttl,
                    },
                );
                let handle = actor.handle();
                pump(&context, CH_BLOCKS, blocks_r, mailbox.clone());
                pump(&context, CH_TXS, txs_r, mailbox.clone());
                pump(&context, CH_APP, app_r, mailbox.clone());
                let engine = engine::build(
                    context.child("engine"),
                    scheme,
                    oracle_p2p,
                    mailbox,
                    "peal-links".to_string(),
                    cfg.genesis,
                    &cfg.params,
                );
                let _ = handle_tx.send(handle);
                context.child("actor").spawn(move |_| actor.run());
                network.start();
                let engine_handle = engine.start(vote, cert, resolver);
                let _ = engine_handle.await;
            });
        })?;
    handle_rx
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| anyhow::anyhow!("consensus runtime did not start"))
}
