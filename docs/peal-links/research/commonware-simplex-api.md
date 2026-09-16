# Commonware simplex API map, crates 2026.9.0

Scope: exact API surface for wiring a deterministic ledger (ordered operations, exposes a state root) to
`commonware_consensus::simplex`. Everything below was copied from the `v2026.9.0` tag of
https://github.com/commonwarexyz/monorepo (commit `d476a2361ce6840d2b9d0aa6fb30a924429046d4`), workspace
`version = "2026.9.0"` (`Cargo.toml:64`). Published: docs.rs serves `/commonware-consensus/2026.9.0/`,
`/commonware-p2p/2026.9.0/`, `/commonware-runtime/2026.9.0/`, `/commonware-cryptography/2026.9.0/` (HTTP 302 to the
rendered crate), and crates.io lists `commonware-consensus 2026.9.0` created 2026-09-03, not yanked.

Path shorthand: `B = https://github.com/commonwarexyz/monorepo/blob/v2026.9.0`. Line numbers are from the raw files at
that tag. Stability: `simplex` and the `Automaton`/`Relay`/`Reporter` traits are in `stability_scope!(BETA ...)`
(`consensus/src/lib.rs:14,83`); `marshal` is BETA, `Application` (marshal-side) is ALPHA (`lib.rs:264-275`).

## 1. `simplex::Engine` (B/consensus/src/simplex/engine.rs)

Generics, copied from `engine.rs:22-32` (same bounds on `impl` at `45-55`):

```rust
pub struct Engine<
    E: BufferPooler + Clock + CryptoRng + Spawner + Storage + Metrics,   // runtime context
    S: Scheme<D>,                                                          // signing scheme (simplex::scheme::Scheme)
    L: elector::Config<S>,                                                 // leader election config
    B: Blocker<PublicKey = S::PublicKey>,                                  // p2p blocker (the network Oracle)
    D: Digest,                                                             // payload digest
    A: CertifiableAutomaton<Context = Context<D, S::PublicKey>, Digest = D>,
    R: Relay<Digest = D, PublicKey = S::PublicKey, Plan = Plan<S::PublicKey>>,
    F: Reporter<Activity = Activity<S, D>>,
    T: Strategy,                                                           // commonware_parallel (Sequential works)
>
```

`engine.rs:58`: `pub fn new(mut context: E, cfg: Config<S, L, B, D, A, R, F, T>) -> Self` (calls `cfg.assert` which
panics on bad timeouts, `engine.rs:60`, `config.rs:270-316`).

`engine.rs:186-200`:

```rust
pub fn start(
    mut self,
    vote_network:        (impl Sender<PublicKey = S::PublicKey>, impl Receiver<PublicKey = S::PublicKey>),
    certificate_network: (impl Sender<PublicKey = S::PublicKey>, impl Receiver<PublicKey = S::PublicKey>),
    resolver_network:    (impl Sender<PublicKey = S::PublicKey>, impl Receiver<PublicKey = S::PublicKey>),
) -> Handle<()>
```

Channel semantics (`engine.rs:153-185`): `vote_network` carries Notarize/Nullify/Finalize votes; `certificate_network`
carries Notarization/Nullification/Finalization; `resolver_network` is request/response certificate backfill.

`Config` struct, `B/consensus/src/simplex/config.rs:136-254` (all fields, exact types):

| field | type | line |
|---|---|---|
| `scheme` | `S` | 160 |
| `elector` | `L` | 168 |
| `blocker` | `B` | 173 |
| `automaton` | `A` | 176 |
| `relay` | `R` | 179 |
| `reporter` | `F` | 193 |
| `track_historical_votes` | `bool` | 201 |
| `strategy` | `T` | 204 |
| `partition` | `String` (journal partition name) | 207 |
| `mailbox_size` | `NonZeroUsize` | 211 |
| `epoch` | `Epoch` | 214 |
| `floor` | `Floor<S, D>` | 217 |
| `replay_buffer` | `NonZeroUsize` | 220 |
| `write_buffer` | `NonZeroUsize` | 223 |
| `page_cache` | `commonware_runtime::buffer::paged::CacheRef` | 226 |
| `leader_timeout` | `Duration` | 230 |
| `certification_timeout` | `Duration` (must be > leader_timeout) | 236 |
| `timeout_retry` | `Duration` | 240 |
| `view_retention` | `ViewDelta` | 244 |
| `skip` | `SkipPolicy` | 247 |
| `fetch_timeout` | `Duration` | 250 |
| `forward` | `ForwardPolicy` | 253 |

Supporting enums in the same file: `SkipBudget { Participants, Fixed(NonZeroU64) }` (`:21-27`),
`SkipPolicy { Disabled, Enabled { timeout: Duration, budget: SkipBudget } }` (`:43-55`),
`ForwardPolicy { Disabled, SilentVoters, SilentLeader }` (`:66-79`),
`Floor<S: Scheme, D: Digest> { Genesis(D), Finalized(Finalization<S, D>) }` (`:96-101`). Doc at `:88-94`: the floor
must be durable and never move backwards across restarts. Re-exports: `simplex::{Config, Floor, ForwardPolicy,
SkipBudget, SkipPolicy, Engine, Plan}` from `B/consensus/src/simplex/mod.rs:561-564,614`.

## 2. Application-facing traits (B/consensus/src/lib.rs)

`Automaton`, `lib.rs:103-162`:

```rust
pub trait Automaton: Clone + Send + 'static {
    type Context;
    type Digest: Digest;
    fn propose(&mut self, context: Self::Context)
        -> impl Future<Output = oneshot::Receiver<Self::Digest>> + Send;            // :133-136
    fn verify(&mut self, context: Self::Context, payload: Self::Digest)
        -> impl Future<Output = oneshot::Receiver<bool>> + Send;                    // :157-161
}
```
`oneshot` is `commonware_utils::channel::oneshot` (`lib.rs:86`). Contract (`:138-153`): `verify` is single-shot per
`(context, payload)`; return `false` only for permanently invalid; keep pending (do not resolve) to abstain.

`CertifiableAutomaton`, `lib.rs:169-209`: `pub trait CertifiableAutomaton: Automaton` with one method
`fn certify(&mut self, _round: Round, _payload: Self::Digest) -> impl Future<Output = oneshot::Receiver<bool>> + Send`
that has a default body sending `true` (`:197-208`). An `impl CertifiableAutomaton for X {}` is enough (the log example
does exactly this, `examples/log/src/application/ingress.rs:76-78`).

`Relay`, `lib.rs:215-231`:
```rust
pub trait Relay: Clone + Send + 'static {
    type Digest: Digest;
    type PublicKey: PublicKey;
    type Plan: Send;
    fn broadcast(&mut self, payload: Self::Digest, plan: Self::Plan) -> Feedback;
}
```
For simplex, `Plan` must be `simplex::Plan<S::PublicKey>` (`engine.rs:29`), defined at `simplex/mod.rs:614-637`:
`Plan::Propose { round: Round }` and `Plan::Forward { round: Round, recipients: Recipients<P> }`.
`Feedback` is `commonware_actor::Feedback { Ok, Backoff, Closed }` (`B/actor/src/lib.rs:15-22`).

`Reporter`, `lib.rs:234-245`: `type Activity; fn report(&mut self, activity: Self::Activity) -> Feedback;`.
For simplex, `Activity = simplex::types::Activity<S, D>` (`engine.rs:30`), an enum at
`B/consensus/src/simplex/types.rs:2330-2352` with variants `Notarize, Notarization, Certification, Nullify,
Nullification, Finalize, Finalization, ConflictingNotarize, ConflictingFinalize, NullifyFinalize`. The finalized
payload is `Activity::Finalization(f)` with `f.proposal.payload` (used in `examples/log/src/application/reporter.rs:31-33`).
`Reporters<A, R1, R2>` (`consensus/src/reporter.rs:24`, `From<(R1, R2)>` at `:88`) fans one activity to two reporters.

`Context`, `B/consensus/src/simplex/types.rs:22-37`:
```rust
pub struct Context<D: Digest, P: PublicKey> {
    pub round: Round,          // Round { epoch, view }; round.epoch(), round.view() at consensus/src/types.rs:630-638
    pub leader: P,
    pub parent: (View, D),     // parent view and parent payload digest
}
```
No height field: height is the application's responsibility (marshal adds it, see section 7).

## 3. Validator set and leader election (B/consensus/src/simplex/elector.rs)

There is no separate `Supervisor` in 2026.9.0. The validator set lives in the signing scheme
(`scheme.participants()`, see section 4) and the engine passes it to the elector: `engine.rs:65`
`let elector = cfg.elector.build(cfg.scheme.participants());`.

```rust
pub trait Config<S: Scheme>: Clone + Send + 'static {                               // elector.rs:51-63
    type Elector: Elector<S>;
    fn build(self, participants: &Set<S::PublicKey>) -> Self::Elector;
}
pub trait Elector<S: Scheme>: Clone + Send + 'static {                              // elector.rs:207-230
    fn terms(&self) -> Terms;
    fn elect(&self, round: Round, certificate: Option<&S::Certificate>) -> Participant;
}
pub struct RoundRobin<H: Hasher = Sha256> { seed: Option<Vec<u8>>, terms: Terms, .. }   // :240-244, #[derive(Default)]
impl<H: Hasher> RoundRobin<H> {
    pub fn shuffled(seed: &[u8]) -> Self                                                // :261
    pub const fn with_term(mut self, term_length: TermLength, stall_timeout: Duration,
                           optimistic_views: ViewDelta) -> Self                         // :282-290
}
impl<S: Scheme, H: Hasher> Config<S> for RoundRobin<H> { type Elector = RoundRobinElector<S>; .. }  // :293-313
```
Leader = `participants[(epoch + term_index) % n]` over an optionally shuffled permutation (`:330-340`). For a static
ed25519 set use `RoundRobin::<Sha256>::default()` exactly as `examples/log/src/main.rs:201`. `Random` (`:368`) only
works with `bls12381_threshold_vrf::Scheme` (`:425`).

## 4. Signing scheme: ed25519 for simplex

`pub type Scheme = commonware_consensus::simplex::scheme::ed25519::Scheme;` (`examples/log/src/application/mod.rs:13`).
`B/consensus/src/simplex/scheme/ed25519.rs:12` is a single line: `impl_certificate_ed25519!(Subject<'a, D>, Namespace, N3f1);`.
The macro (`B/cryptography/src/ed25519/certificate/mod.rs:417`, body at macro lines 22-53) generates:

```rust
#[derive(Clone, Debug)] pub struct Scheme { generic: Generic<Namespace> }
impl Scheme {
    pub fn signer(namespace: &[u8], participants: commonware_utils::ordered::Set<ed25519::PublicKey>,
                  private_key: ed25519::PrivateKey) -> Option<Self>     // None if private_key not in participants
    pub fn verifier(namespace: &[u8], participants: Set<ed25519::PublicKey>) -> Self
}
```
It implements `commonware_cryptography::certificate::Scheme` (`B/cryptography/src/certificate.rs:347`) whose
`fn participants(&self) -> &Set<Self::PublicKey>` (`:356`) and `fn me(&self) -> Option<Participant>` (`:353`) supply
the validator set and the local signer index. `Faults = N3f1` means quorum is 2f+1 of 3f+1
(`Generic::assemble` requires `participants.quorum::<S::Faults>()`, `ed25519/certificate/mod.rs:203-204`).

Identity: `commonware_cryptography::ed25519::{PrivateKey, PublicKey, Signature, Batch}` (`B/cryptography/src/ed25519/mod.rs:35`).
`Signer::public_key(&self) -> Self::PublicKey` (`B/cryptography/src/lib.rs:101`); `Signer::from_seed(seed: u64)`
(`lib.rs:121`, documented insecure, examples only); production keys via `Random::random(rng)` (`ed25519/scheme.rs:61-67`)
or `Read::read_cfg` from 32 bytes (`ed25519/scheme.rs:76-86`). The participant identity used by simplex, by p2p
authentication, and by `Context::leader` is the same `ed25519::PublicKey`. Participant ordering is the `Set`'s sorted
order, and signer indices are positions in that set (`Config.scheme` doc, `config.rs:147-156`).

Namespace: the example derives `union(APPLICATION_NAMESPACE, b"_CONSENSUS")` (`main.rs:187`); the scheme appends
`_NOTARIZE`/`_NULLIFY`/`_FINALIZE`/`_SEED` (`scheme/mod.rs:150-181`).

## 5. Networking (B/p2p/src)

Traits simplex expects (`p2p/src/lib.rs`): `Sender: LimitedSender` (`:139`) with blanket
`impl<S: LimitedSender> Sender for S {}` (`:184`), so any `LimitedSender` qualifies;
`Receiver { type Error; type PublicKey; fn recv(&mut self) -> impl Future<Output = Result<Message<Self::PublicKey>, Self::Error>> + Send; }`
(`:187-199`, `Message<P> = (P, IoBuf)` at `:37`); `Blocker { type PublicKey; fn block(..) -> Feedback; fn blocked(..) }`
(`:380-393`); `Manager::track<R>(&mut self, id: u64, peers: R) -> Feedback where R: Into<TrackedPeers<..>>` (`:309-338`);
`Recipients<P> { All, Some(Vec<P>), One(P) }` (`:44-48`); `Channel = u64` (`:40`).

Authenticated, multi-process: two flavours under `commonware_p2p::authenticated` (`authenticated/mod.rs:15-16`):
`discovery` (gossip-based peer discovery with bootstrappers; used by log and reshare) and `lookup` (address-book
based, `lookup/config.rs:173-179` `Config::local(crypto, namespace, listen, max_peers_per_set, max_message_size)`).
Discovery API, `B/p2p/src/authenticated/discovery/`:

```rust
// config.rs:200-208
pub fn local(crypto: C, namespace: &[u8], listen: SocketAddr, dialable: impl Into<Ingress>,
             bootstrappers: Vec<Bootstrapper<C::PublicKey>>, max_peers_per_set: NonZeroUsize,
             max_message_size: u32) -> Self            // Config<C: Signer>; allow_private_ips = true
// network.rs:67
pub fn new(context: E, cfg: Config<C>) -> (Self, tracker::Oracle<C::PublicKey>)
// network.rs:169-176
pub fn register(&mut self, channel: Channel, rate: Quota)
    -> (channels::Sender<C::PublicKey, E>, channels::Receiver<C::PublicKey>)
// network.rs:192
pub fn start(mut self) -> Handle<()>
```
`Oracle<C>` (`discovery/actors/tracker/ingress.rs:276`) implements `Manager` (`:333-342`, `track(index, peers)`) and
`Blocker` (`:344`), so the same value is passed as `Config.blocker`. `Bootstrapper<P> = (P, Ingress)`; the example
builds `(verifier, socket_addr.into())` (`main.rs:143`). `authenticated::peer_set_limit(participants, local) ->
NonZeroUsize` (`p2p/src/sizing.rs:13-27`, re-exported `authenticated/mod.rs:12`) sizes `max_peers_per_set`.
Channel types `channels::Sender<P, C: Clock>` (`authenticated/channels.rs:75`, `LimitedSender` at `:105`) and
`channels::Receiver<P>` (`:129`, `Receiver` at `:145`).

Simulated (deterministic tests), `B/p2p/src/simulated/`:
`Config { max_size: u32, max_peers_per_set: NonZeroUsize, disconnect_on_block: bool, tracked_peer_sets: NonZeroUsize }`
(`network.rs:125-149`); `Network::new(context, cfg) -> (Self, Oracle<P, E>)` (`:223`);
`Network::new_with_peers(context, cfg, peers) -> (Self, Oracle<P, E>)` async (`:265`); `start(self) -> Handle<()>` (`:928`).
`Oracle::control(&self, me: P) -> Control<P, E>` (`ingress.rs:193`); `Control::register(&self, channel: Channel, quota: Quota)
-> Result<(Sender<P, E>, Receiver<P>), Error>` async (`:456-460`); `Control` implements `Blocker` (`:473`);
`Oracle::add_link(&self, sender: P, receiver: P, config: Link) -> Result<(), Error>` async (`:260`), links are
unidirectional (`:155-156`); `Link { latency: Duration, jitter: Duration, success_rate: Probability }` (`:158-167`).
The simplex test harness registers channels 0/1/2 per validator with `oracle.control(pk)` and passes the tuples to
`engine.start` (`consensus/src/simplex/mod.rs:879-893, 1104, 1134-1140`).

## 6. Runtime (B/runtime/src)

`Runner` trait (`lib.rs:219-232`): `type Context; fn start<F, Fut>(self, f: F) -> Fut::Output where F: FnOnce(Self::Context) -> Fut, Fut: Future;`.
`Spawner::spawn<F, Fut, T>(self, f: F) -> Handle<T>` (`lib.rs:384-389`), `Spawner::stop(self, value: i32, timeout:
Option<Duration>)` (`:410`), `stopped(&self) -> signal::Signal` (`:422`), `Supervisor::child(&self, label: &'static str)
-> Self` (`:258`). `Handle<T>` at `utils/handle.rs:31`; `ContextCell` and `spawn_cell!` in `utils/cell.rs` (`:13`).

tokio (`tokio/runtime.rs`): `Config::new() -> Self` (`:193`, default 2 worker threads, temp storage dir),
`with_storage_directory(self, p: impl Into<PathBuf>)` (`:257`), `with_worker_threads(self, n: usize)` (`:212`);
`Runner::new(cfg: Config) -> Self` (`:430`); `impl crate::Runner for Runner { type Context = Context; .. }` (`:435-442`).
`tokio::Context` implements `Spawner, Metrics, Clock, Network, Storage, BufferPooler, CryptoRng` (`:645-920`), i.e. all
of `Engine`'s `E` bounds. Usage: `tokio::Runner::new(cfg).start(async |context| { .. })` (`examples/log/src/main.rs:153-168`).

deterministic (`deterministic.rs`): `Runner::new(cfg)` (`:549`), `Runner::seeded(seed: u64)` (`:559`),
`Runner::timed(timeout: Duration)` (`:565`), `start_and_recover(self, f) -> (Fut::Output, Checkpoint)` (`:575`),
`impl crate::Runner for Runner` (`:766`); `Config::new().with_seed(u64)` (`:253, :285`); `Context::auditor()` (`:1119`)
and `storage_audit()` (`:1124`) for determinism assertions. Simplex tests use `deterministic::Runner::timed(Duration::from_secs(300))`
(`simplex/mod.rs:1046`).

## 7. marshal (B/consensus/src/marshal)

Present at 2026.9.0. Purpose (`mod.rs:1-18`): orders finalized blocks and delivers them to a `Reporter` at-least-once,
in height order, with backfill of missing blocks from peers; only works with simplex (`:63`). Delivery type:
`Update<B: Block, A: Acknowledgement = Exact> { Tip(Round, Height, B::Digest), Block(Arc<B>, A) }` (`mod.rs:137-157`),
where the application must ack each `Block` or marshal exits (`:146-148`), and a block is emitted only after durable
persistence (`:154-156`). Requires the payload to implement `Block: Heightable + Codec + Digestible` with
`fn parent(&self) -> Self::Digest` (`lib.rs:61-64`) and, for deferred verification, `CertifiableBlock { type Context;
fn context(&self) -> Self::Context }` (`lib.rs:75-81`).

Constructors: `core::Actor::init(context: E, finalizations_by_height: FC, finalized_blocks: FB, config: Config<..>)
-> (Self, Mailbox<P::Scheme, V>, Floor)` async (`core/actor.rs:179-184`); `start(self, application: impl Reporter<Activity
= Update<..>>, buffer: Buf, resolver: (handler::Receiver<..>, R)) -> Handle<()>` (`:328-333`) or `start_unbuffered`
(`:347`). `Config` fields at `config.rs:44-104` (`provider`, `epocher`, `start: Start<S, C, B> { Genesis(B),
Floor(Finalization) }` (`:18-21`), `partition_prefix`, `mailbox_size`, `view_retention`, archive buffers, `strategy`).
Adaptor `standard::Deferred::new(context: E, application: A, marshal: Mailbox<S, Standard<B>>, epocher: ES) -> Self`
(`standard/deferred.rs:199`) implements `Automaton`/`CertifiableAutomaton`/`Relay`/`Reporter` (`:472, :850, :879, :896`)
for an `A: Application<E, Block = B, Context = Context<B::Digest, S::PublicKey>, Input = ()>` (`:184-197`), where
`Application` is the ALPHA trait at `lib.rs:275-327` (`propose(context: (E, Self::Context), ancestry, input) ->
Option<Self::Block>`, `verify(..) -> bool`).

Reference usage: the **log** example does not use marshal (no `marshal` string in `examples/log/`). The **reshare**
example does: `MarshalActor::init` at `examples/reshare/src/validator.rs:212-236`, `marshal_actor.start(reporters,
buffer, resolver)` at `:377`, `Deferred::new(..)` at `:318-327`, but its consensus engine is wrapped by
`commonware_glue::dkg::orchestrator` (`:328-365`) rather than a direct `simplex::Engine::new`, and it needs
`commonware_broadcast::buffered` (`:142-153`) and `marshal::resolver::p2p` (`:126-138`) on two extra channels.

## 8. Minimal wiring order, from examples/log/src/main.rs

1. Keys and set: `ed25519::PrivateKey::from_seed(k)`; `validators: Set<PublicKey>` via `.try_collect()` (`:104, :120-128`);
   `max_peers_per_set = authenticated::peer_set_limit(&validators, &signer.public_key())` (`:129`).
2. Runtime: `tokio::Config::new().with_storage_directory(dir)`; `tokio::Runner::new(cfg)` (`:153-154`).
3. p2p config before start: `discovery::Config::local(signer.clone(), &union(NS, b"_P2P"), listen, dialable,
   bootstrappers, max_peers_per_set, 1024*1024)` (`:157-165`).
4. `executor.start(async |context| { .. })` (`:168`); inside: `discovery::Network::new(context.child("network"), p2p_cfg)`
   -> `(network, oracle)` (`:170`); `oracle.track(0, validators.clone())` (`:176`); `network.register(0|1|2,
   Quota::per_second(NZU32!(10)))` for vote/certificate/resolver (`:181-184`).
5. Scheme: `Scheme::signer(&union(NS, b"_CONSENSUS"), validators.clone(), signer.clone()).expect(..)` (`:187-189`).
6. Application actor exposes a `Mailbox` that implements `Automaton + CertifiableAutomaton + Relay`
   (`application/ingress.rs:38-92`) and a `Reporter` (`application/reporter.rs:22-41`); `Application::new(context.child
   ("application"), Config { scheme, mailbox_size })` (`:190-196`).
7. `simplex::Config { scheme, elector: RoundRobin::<Sha256>::default(), blocker: oracle, automaton: mailbox.clone(),
   relay: mailbox.clone(), reporter, partition: "log", mailbox_size: NZUsize!(1024), epoch: Epoch::zero(),
   floor: Floor::Genesis(genesis::<Sha256>()), replay_buffer/write_buffer: NZUsize!(1 MiB), leader_timeout: 1s,
   certification_timeout: 2s, timeout_retry: 10s, fetch_timeout: 1s, view_retention: ViewDelta::new(10),
   skip: Enabled { timeout: 11s, budget: Participants }, page_cache: CacheRef::from_pooler(&context, NZU16!(16_384),
   NZUsize!(10_000)), strategy: Sequential, forward: Disabled, track_historical_votes: false }` (`:199-225`).
8. `simplex::Engine::new(context.child("engine"), cfg)`; then `application.start(); network.start();
   engine.start((vote_s, vote_r), (cert_s, cert_r), (res_s, res_r));` (`:226-235`). Order: runtime -> keys/scheme ->
   p2p (new, track, register) -> app actor -> engine -> start app, network, engine.

Where the payload lives: the engine only ever sees `D: Digest` (`Relay` doc, `lib.rs:213-214`). The proposer computes
the digest in `Message::Propose` and sends it on the oneshot (`application/actor.rs:48-58`); `verify` receives
`(Context, digest)` and answers `bool` (`ingress.rs:58-73`); shipping the bytes to peers is `Relay::broadcast`, which
the log example leaves as a no-op (`ingress.rs:85-91`). For the ledger: propose = build a block of ordered operations
on `context.parent`, persist it keyed by digest, return the digest; verify = fetch the bytes for that digest (needs a
broadcast/backfill path, e.g. `commonware_broadcast::buffered` or marshal), check `block.parent == context.parent.1`,
re-execute, compare state root; finalize = act on `Activity::Finalization` from the `Reporter` (or marshal `Update::Block`).

## alto

https://github.com/commonwarexyz/alto is a separate repo; `main` `Cargo.toml` pins `commonware-consensus`,
`-cryptography`, `-p2p`, `-runtime` all `= "2026.9.0"` (lines 26-33) and is itself `version = "2026.9.1"`; latest tag
`v2026.9.1`. It was not read in detail for this map.

## Unverified

- `commonware_glue` (used by reshare) exists in the monorepo tree at `glue/`, but its `orchestrator::SimplexConfig`
  and whether it publishes as a crate on crates.io were not checked.
- `Set::try_collect` (`commonware_utils::{TryCollect, ordered::Set}`) and `commonware_utils::union` were seen only at
  their call sites in `examples/log/src/main.rs:62,120-128,159`; their definitions were not opened.
- `CacheRef::from_pooler(&context, page_size: NonZeroU16, pages: NonZeroUsize)` signature is inferred from call sites
  (`main.rs:221`, `simplex/mod.rs:1131`), not from `runtime/src/utils/buffer/paged/cache.rs`.
- `discovery::Bootstrapper` is asserted to be `(P, Ingress)` from `config.rs:37` (`Vec<Bootstrapper<C::PublicKey>>`),
  `network.rs:81` (destructuring `(peer, _)`), and `main.rs:143`; the type alias line itself was not printed.
- The alto reference application was only checked for its dependency pins, not for how it wires the engine.
- docs.rs pages were confirmed to exist (302 to the crate root) but their rendered content was not compared against
  the tag source; all signatures above come from the tag's raw files.
