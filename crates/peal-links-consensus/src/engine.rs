//! The simplex engine configuration shared by the live (tokio, discovery
//! p2p) and the simulated (deterministic runtime) wirings.

use std::time::Duration;

use commonware_consensus::simplex::elector::RoundRobin;
use commonware_consensus::simplex::scheme::ed25519::Scheme;
use commonware_consensus::simplex::{Config, Engine, Floor, ForwardPolicy, SkipBudget, SkipPolicy};
use commonware_consensus::types::{Epoch, ViewDelta};
use commonware_cryptography::sha256::Digest;
use commonware_cryptography::Sha256;
use commonware_p2p::Blocker;
use commonware_parallel::Sequential;
use commonware_runtime::buffer::paged::CacheRef;
use commonware_runtime::{BufferPooler, Clock, Metrics, Spawner, Storage};
use commonware_utils::ordered::Set;
use commonware_utils::{union, NZUsize, NZU16};

use crate::actor::Mailbox;
use crate::block::Id;
use crate::{PrivateKey, PublicKey};

/// Consensus timing. Defaults follow the upstream `log` example; a local
/// deployment on one machine needs nothing tighter.
#[derive(Clone, Debug)]
pub struct Params {
    pub leader_timeout: Duration,
    pub certification_timeout: Duration,
    pub timeout_retry: Duration,
    pub fetch_timeout: Duration,
    pub view_retention: u64,
    pub skip_timeout: Duration,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            leader_timeout: Duration::from_secs(1),
            certification_timeout: Duration::from_secs(2),
            timeout_retry: Duration::from_secs(10),
            fetch_timeout: Duration::from_secs(1),
            view_retention: 10,
            skip_timeout: Duration::from_secs(11),
        }
    }
}

/// Domain separation for everything the validators sign: the consensus
/// domain (circuit id and namespaces, by way of the genesis digest) with
/// the engine's own suffixes appended by the scheme.
pub fn consensus_namespace(genesis: &Id) -> Vec<u8> {
    union(b"peal-links/v1/consensus/", genesis)
}

pub fn p2p_namespace(genesis: &Id) -> Vec<u8> {
    union(&consensus_namespace(genesis), b"_P2P")
}

/// The signing scheme for this validator, or `None` if its key is not in
/// the set.
pub fn scheme(genesis: &Id, validators: &Set<PublicKey>, key: &PrivateKey) -> Option<Scheme> {
    Scheme::signer(
        &union(&consensus_namespace(genesis), b"_CONSENSUS"),
        validators.clone(),
        key.clone(),
    )
}

pub type LinksEngine<E, B> =
    Engine<E, Scheme, RoundRobin<Sha256>, B, Digest, Mailbox, Mailbox, Mailbox, Sequential>;

pub fn build<E, B>(
    context: E,
    scheme: Scheme,
    blocker: B,
    mailbox: Mailbox,
    partition: String,
    genesis: Id,
    params: &Params,
) -> LinksEngine<E, B>
where
    E: BufferPooler + Clock + rand_core::CryptoRng + Spawner + Storage + Metrics,
    B: Blocker<PublicKey = PublicKey>,
{
    let cfg = Config {
        scheme,
        elector: RoundRobin::<Sha256>::default(),
        blocker,
        automaton: mailbox.clone(),
        relay: mailbox.clone(),
        reporter: mailbox,
        strategy: Sequential,
        partition,
        mailbox_size: NZUsize!(1024),
        epoch: Epoch::zero(),
        floor: Floor::Genesis(Digest(genesis)),
        leader_timeout: params.leader_timeout,
        certification_timeout: params.certification_timeout,
        timeout_retry: params.timeout_retry,
        fetch_timeout: params.fetch_timeout,
        view_retention: ViewDelta::new(params.view_retention),
        skip: SkipPolicy::Enabled {
            timeout: params.skip_timeout,
            budget: SkipBudget::Participants,
        },
        replay_buffer: NZUsize!(1024 * 1024),
        write_buffer: NZUsize!(1024 * 1024),
        page_cache: CacheRef::from_pooler(&context, NZU16!(16_384), NZUsize!(10_000)),
        forward: ForwardPolicy::Disabled,
        track_historical_votes: false,
    };
    Engine::new(context, cfg)
}
