//! Validators on the deterministic runtime over the simulated network:
//! the same actor and engine as a live validator, driven by a test.

use std::num::NonZeroU32;
use std::sync::Arc;
use std::time::Duration;

use commonware_p2p::simulated::{Control, Oracle};
use commonware_runtime::deterministic;
use commonware_runtime::{Quota, Spawner, Supervisor};
use commonware_utils::ordered::Set;

use crate::actor::{pump, Actor, AppHandler, Config as ActorConfig, DepositOracle, Handle};
use crate::block::Id;
use crate::engine::{self, Params};
use crate::state::Shared;
use crate::wire::{CH_APP, CH_BLOCKS, CH_CERTIFICATE, CH_RESOLVER, CH_TXS, CH_VOTE};
use crate::{PrivateKey, PublicKey};

pub type SimOracle = Oracle<PublicKey, deterministic::Context>;

pub struct SimValidator {
    pub private_key: PrivateKey,
    pub validators: Vec<PublicKey>,
    pub genesis: Id,
    pub params: Params,
    pub max_block_txs: usize,
    pub mempool_ttl: Duration,
}

/// Register this validator's channels on the simulated network and start
/// its actor and engine. The caller links the peers.
pub async fn start(
    context: deterministic::Context,
    oracle: &SimOracle,
    cfg: SimValidator,
    state: Shared,
    dep_oracle: Arc<dyn DepositOracle>,
    app: Arc<dyn AppHandler>,
) -> Handle {
    let me = commonware_cryptography::Signer::public_key(&cfg.private_key);
    let set: Set<PublicKey> = Set::from_iter_dedup(cfg.validators.iter().cloned());
    let scheme =
        engine::scheme(&cfg.genesis, &set, &cfg.private_key).expect("key in the validator set");
    let control: Control<PublicKey, deterministic::Context> = oracle.control(me.clone());
    let quota = Quota::per_second(NonZeroU32::MAX);
    let vote = control.register(CH_VOTE, quota).await.expect("register");
    let cert = control
        .register(CH_CERTIFICATE, quota)
        .await
        .expect("register");
    let resolver = control
        .register(CH_RESOLVER, quota)
        .await
        .expect("register");
    let (blocks_s, blocks_r) = control.register(CH_BLOCKS, quota).await.expect("register");
    let (txs_s, txs_r) = control.register(CH_TXS, quota).await.expect("register");
    let (app_s, app_r) = control.register(CH_APP, quota).await.expect("register");
    let (actor, mailbox) = Actor::new(
        context.child("application"),
        ActorConfig {
            me: me.clone(),
            validators: cfg.validators.clone(),
            genesis: cfg.genesis,
            state,
            oracle: dep_oracle,
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
        oracle.control(me.clone()),
        mailbox,
        format!("validator-{me}"),
        cfg.genesis,
        &cfg.params,
    );
    context.child("actor").spawn(move |_| actor.run());
    engine.start(vote, cert, resolver);
    handle
}
