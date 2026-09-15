# Commonware Library: crates relevant to a deterministic private-payment ledger

Research date: 2026-09-16. Scope: which crates in the Commonware monorepo
(https://github.com/commonwarexyz/monorepo) fit (a) an MMR for receipts, (b) a persistent
journal / key-value store, (c) optional simplex consensus for a local multi-node deployment,
and (d) a deterministic runtime for tests. Every claim below carries a URL; anything not
confirmed is listed under "Unverified" at the end.

## 1. Discovery sources

- `https://commonware.xyz/llms.txt`: source is mirrored at `/code/v2026.9.0/`, `/code/v2026.7.1/`,
  `/code/v2026.7.0/`; paths are not browseable and must be found via `https://commonware.xyz/sitemap.xml`;
  an MCP server exists at `https://mcp.commonware.xyz`.
- `https://commonware.xyz/mcp` describes the MCP server as "unlimited access to a
  version-pinned index of all source code and documentation, along with a ranked search tool
  that surfaces more relevant snippets than grep (with surrounding context)". Transport is
  Streamable HTTP at `https://mcp.commonware.xyz`; the documented Claude Code command is
  `claude mcp add --transport http commonware-library https://mcp.commonware.xyz`.
  The server's source is `mcp/` in the monorepo; its README lists the tools `get_file`,
  `search_code`, `list_versions`, `list_crates`, `get_crate_readme`, `get_overview`,
  `list_files` (https://github.com/commonwarexyz/monorepo/blob/main/mcp/README.md).
  Nothing was installed for this research.

## 2. Published versions (crates.io, checked 2026-09-16)

All seven crates are versioned together from the workspace and share one release.

| Crate | Latest | Published | Edition | crates.io / docs.rs |
|---|---|---|---|---|
| commonware-runtime | 2026.9.0 | 2026-09-03 | 2024 | https://crates.io/api/v1/crates/commonware-runtime , https://docs.rs/commonware-runtime |
| commonware-storage | 2026.9.0 | 2026-09-03 | 2024 | https://crates.io/api/v1/crates/commonware-storage , https://docs.rs/commonware-storage |
| commonware-consensus | 2026.9.0 | 2026-09-03 | 2024 | https://crates.io/api/v1/crates/commonware-consensus , https://docs.rs/commonware-consensus |
| commonware-cryptography | 2026.9.0 | 2026-09-03 | 2024 | https://crates.io/api/v1/crates/commonware-cryptography , https://docs.rs/commonware-cryptography |
| commonware-codec | 2026.9.0 | 2026-09-03 | 2024 | https://crates.io/api/v1/crates/commonware-codec , https://docs.rs/commonware-codec |
| commonware-p2p | 2026.9.0 | 2026-09-03 | 2024 | https://crates.io/api/v1/crates/commonware-p2p , https://docs.rs/commonware-p2p |
| commonware-utils | 2026.9.0 | 2026-09-03 | 2024 | https://crates.io/api/v1/crates/commonware-utils , https://docs.rs/commonware-utils |

- Previous releases: 2026.7.1 (2026-08-17) and 2026.7.0 (2026-07-15). License for all:
  `MIT OR Apache-2.0` (crates.io API responses above).
- crates.io does not expose `rust_version` for these crates, but the workspace manifest at the
  release tag sets `rust-version = "1.95.0"` and `edition = "2024"`
  (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/Cargo.toml,
  `[workspace.package]`). There is no `rust-toolchain.toml` at that tag (HTTP 404).
- Release tag `v2026.9.0` = commit `d476a2361ce6840d2b9d0aa6fb30a924429046d4`
  (https://api.github.com/repos/commonwarexyz/monorepo/tags; release page
  https://github.com/commonwarexyz/monorepo/releases/tag/v2026.9.0, published 2026-09-03T21:40:41Z).
- `main` at research time: `28a78b999aff4d39767266b67e31c423da878bde`, 2026-09-15, "(#4802)"
  (https://api.github.com/repos/commonwarexyz/monorepo/commits/main).
- Features: storage `arbitrary`, `default`(=`std`), `fuzzing`, `std`, `test-traits`, `test-utils` (crates.io API);
  runtime `arbitrary`, `bench`, `external`, `loom`, `test-utils`, `iouring*`, `tokio-console`
  (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/runtime/Cargo.toml);
  consensus `mocks`, `arbitrary` (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/consensus/Cargo.toml).

## 3. commonware-storage 2026.9.0: module and type names

Top-level modules on docs.rs (https://docs.rs/commonware-storage/latest/commonware_storage/):
`archive`, `bmt`, `cache`, `freezer`, `index`, `journal`, `merkle`, `metadata`, `ordinal`,
`qmdb`, `queue`, `rmap`, `translator`. Note: there is no top-level `mmr` or `adb` module in
this release; `https://docs.rs/commonware-storage/latest/commonware_storage/mmr/index.html`
and `.../adb/index.html` both return 404. The MMR lives under `merkle`, and the authenticated
databases live under `qmdb`.

### 3a. MMR (receipts log): `commonware_storage::merkle`

- Module docs: https://docs.rs/commonware-storage/latest/commonware_storage/merkle/index.html ("Shared types for
  Merkle-family data structures (MMR, MMB)"). Submodules `mmr`, `mmb`, `mem`, `full`, `compact`, `batch`, `hasher`,
  `path`, `storage`, `verification`; re-exports `Location`, `Position`, `Proof`, `Readable`, `Family`
  (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/storage/src/merkle/mod.rs).
- `merkle::mmr` module doc defines MMR terminology (position vs location, peaks, bagging)
  (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/storage/src/merkle/mmr/mod.rs).
- In-memory MMR: `commonware_storage::merkle::mmr::mem::Mmr<D>` is a type alias for
  `merkle::mem::Mem<mmr::Family, D>`
  (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/storage/src/merkle/mmr/mem.rs).
  `Mem` methods (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/storage/src/merkle/mem.rs):
  `init(Config)`, `root`, `size`, `leaves`, `bounds`, `get_node`, `prune(loc)`, `prune_all`, `proof`, `range_proof`,
  `new_batch`, `new_batch_with_strategy`, `apply_batch`. Elements are appended via
  `UnmerkleizedBatch::add(hasher, &[u8])` -> `.merkleize(..)` -> `apply_batch`.
- Journal-backed (persistent) MMR: `commonware_storage::merkle::mmr::full::Mmr<E, D, S>` is
  an alias for `merkle::full::Merkle<mmr::Family, E, D, S>`
  (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/storage/src/merkle/mmr/full.rs).
  `Merkle` methods (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/storage/src/merkle/persisted/full.rs):
  `init`, `init_sync`, `new_batch`, `apply_batch`, `root`, `proof`, `range_proof`, `historical_proof`, `historical_range_proof`,
  `get_node`, `get_nodes`, `pinned_nodes_at`, `flush`, `sync`, `start_sync`, `prune(loc)`, `prune_all`, `destroy`.
  `Config<S>`: `journal_partition`, `metadata_partition`, `items_per_blob`, `write_buffer`, `replay_buffer`, `strategy`, `page_cache`.
- Proofs: `commonware_storage::merkle::Proof<F, D>` with `verify_element_inclusion`,
  `verify_range_inclusion`, `verify_multi_inclusion`, `reconstruct_root`,
  `verify_range_inclusion_and_extract_digests`, `verify_proof_and_pinned_nodes`
  (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/storage/src/merkle/proof.rs).
  Proof generation helpers: `merkle::mmr::verification::{range_proof, historical_range_proof,
  multi_proof, ProofStore}`
  (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/storage/src/merkle/mmr/verification.rs).
- Hasher: trait `merkle::hasher::Hasher<F>` and the default `merkle::hasher::Standard<H>`
  wrapping a `commonware_cryptography` hasher
  (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/storage/src/merkle/hasher.rs).

### 3b. Journal (append-only persistence): `commonware_storage::journal`

- Module docs: https://docs.rs/commonware-storage/latest/commonware_storage/journal/index.html
  ("An append-only log for storing arbitrary data"); submodules `authenticated`, `contiguous`,
  `segmented`.
- Position-indexed journals: https://docs.rs/commonware-storage/latest/commonware_storage/journal/contiguous/index.html
  with traits `Contiguous` (`bounds`, `read`, `read_many`, `replay`) and `Mutable`
  (`append`, `append_many`, `prune`, `rewind`, `start_sync`, `commit`, `sync`, `destroy`)
  (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/storage/src/journal/contiguous/mod.rs).
- Concrete types: `journal::contiguous::fixed::Journal<E, A>` (`Config`: `partition`, `items_per_blob`, `page_cache`,
  `write_buffer`, `replay_buffer`; methods `init`, `init_at_size`, `append`, `append_many`, `size`, `rewind`, `prune`,
  `commit`, `sync`, `start_sync`, `snapshot`, `destroy`;
  https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/storage/src/journal/contiguous/fixed.rs) and
  `journal::contiguous::variable::Journal<E, V>` for `Codec` items, same method family
  (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/storage/src/journal/contiguous/variable.rs).
- Ownership rule (docs.rs contiguous page): mutating methods take the journal by value and
  return it; on error or dropped future, un-durable state is discarded, disk state remains.

### 3c. Authenticated key-value store: `commonware_storage::qmdb`

- Module docs: https://docs.rs/commonware-storage/latest/commonware_storage/qmdb/index.html
  ("A collection of authenticated databases inspired by QMDB"). Submodules: `any`,
  `current`, `immutable`, `keyless`, `operation`, `store`, `batch_chain`, `sync`, `verify`.
- Lifecycle (module doc, https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/storage/src/qmdb/mod.rs):
  `db.new_batch().write(key, Some(value)).write(other, None).merkleize(&db, None).await?`,
  `batch.root()`, `db.apply_batch(batch).await?`, then `db.commit().await?`; `sync()` is the
  crash-safe form, `start_sync()` the pipelined form; `validate_batch` pre-checks without
  consuming the handle.
- `qmdb::any::unordered::fixed::Db<F, E, K, V, H, T, S>` with `init(context, cfg)`
  (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/storage/src/qmdb/any/unordered/fixed.rs);
  shared `qmdb::any::db::Db` methods: `get`, `get_many`, `get_metadata`, `bounds`,
  `proof`, `historical_proof`, `pinned_nodes_at`, `prune`, `rewind`, `commit`, `sync`,
  `start_sync`, `destroy`
  (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/storage/src/qmdb/any/db.rs).
- Proof verification: `qmdb::verify::{verify_proof, verify_proof_and_pinned_nodes,
  verify_proof_and_extract_digests, create_proof_store, create_multi_proof,
  verify_multi_proof}`
  (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/storage/src/qmdb/verify.rs).
- Small unauthenticated KV for config: `commonware_storage::metadata` (docs.rs crate index above).

## 4. commonware-consensus 2026.9.0: simplex entry points

- Top-level modules: `aggregation`, `marshal`, `simplex`, `types`
  (https://docs.rs/commonware-consensus/latest/commonware_consensus/). There is no
  `threshold_simplex` module in this release
  (https://docs.rs/commonware-consensus/latest/commonware_consensus/threshold_simplex/index.html
  returns 404); threshold signing is a `simplex::scheme` variant instead.
- `simplex` (https://docs.rs/commonware-consensus/latest/commonware_consensus/simplex/index.html):
  "Simple and fast BFT agreement inspired by Simplex Consensus"; submodules `types`,
  `scheme`, `elector`, `config`. Schemes: `scheme::ed25519`, `scheme::secp256r1`,
  `scheme::bls12381_multisig`, `scheme::bls12381_threshold::{standard, vrf}`
  (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/consensus/src/simplex/scheme/mod.rs).
- Engine (https://docs.rs/commonware-consensus/latest/commonware_consensus/simplex/struct.Engine.html):
  `Engine<E, S: Scheme<D>, L: elector::Config<S>, B: Blocker, D: Digest, A: CertifiableAutomaton<Context = Context<D, S::PublicKey>, Digest = D>, R: Relay<Digest = D, PublicKey = S::PublicKey, Plan = Plan<S::PublicKey>>, F: Reporter<Activity = Activity<S, D>>, T: Strategy>`;
  `Engine::new(context, cfg)`; `Engine::start(self, vote_network, certificate_network, resolver_network) -> Handle<()>`
  (three `(Sender, Receiver)` pairs from `commonware_p2p`).
- Config (https://docs.rs/commonware-consensus/latest/commonware_consensus/simplex/config/struct.Config.html):
  `scheme`, `elector`, `blocker`, `automaton`, `relay`, `reporter`, `track_historical_votes`, `strategy`, `partition`,
  `mailbox_size`, `epoch`, `floor`, `replay_buffer`, `write_buffer`, `page_cache`, `leader_timeout`, `certification_timeout`,
  `timeout_retry`, `view_retention`, `skip`, `fetch_timeout`, `forward`. Electors: `elector::RoundRobin`, `elector::Random`
  (BLS threshold VRF) (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/consensus/src/simplex/elector.rs).
- Application traits (crate root, https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/consensus/src/lib.rs):
  - `Automaton` (https://docs.rs/commonware-consensus/latest/commonware_consensus/trait.Automaton.html):
    `type Context; type Digest: Digest; fn propose(&mut self, context) -> impl Future<Output = oneshot::Receiver<Digest>>; fn verify(&mut self, context, payload) -> impl Future<Output = oneshot::Receiver<bool>>`.
  - `CertifiableAutomaton: Automaton` (https://docs.rs/commonware-consensus/latest/commonware_consensus/trait.CertifiableAutomaton.html):
    provided `fn certify(&mut self, round: Round, payload) -> impl Future<Output = oneshot::Receiver<bool>>`;
    this is what `simplex::Engine` requires.
  - `Relay` (https://docs.rs/commonware-consensus/latest/commonware_consensus/trait.Relay.html):
    `type Digest; type PublicKey; type Plan; fn broadcast(&mut self, payload, plan) -> Feedback`.
  - `Reporter` (https://docs.rs/commonware-consensus/latest/commonware_consensus/trait.Reporter.html):
    `type Activity; fn report(&mut self, activity) -> Feedback`. `Feedback` is
    `commonware_actor::Feedback` (lib.rs line 84). `Reporters` combinator in
    https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/consensus/src/reporter.rs.
  - Also `Block`, `CertifiableBlock`, `Application`, `Monitor`, `Viewable`, `Epochable`,
    `Roundable`, `Heightable` (docs.rs crate index). `marshal` gives "ordered delivery of
    finalized blocks" on top of simplex.
- Reference deployments: https://github.com/commonwarexyz/alto and the in-repo `examples/log`
  (four local participants, https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/examples/log/README.md).

## 5. commonware-runtime 2026.9.0: deterministic and tokio

- Crate index (https://docs.rs/commonware-runtime/latest/commonware_runtime/): modules
  `deterministic`, `tokio`, `benchmarks`, `mocks`, `telemetry`, `iobuf`, `utils`; traits
  `Runner`, `Spawner`, `Clock`, `Storage`, `Blob`, `BufferPooler`, `Network`, `Listener`,
  `Stream`, `Sink`, `Resolver`, `Metrics`, `Supervisor`, `Strategizer`.
- `deterministic` (https://docs.rs/commonware-runtime/latest/commonware_runtime/deterministic/index.html): a runtime
  that "randomly selects tasks to run based on a seed". Entry points `deterministic::Runner::default()`,
  `Runner::seeded(u64)`, `Runner::timed(Duration)`, `Runner::new(Config)`, `Runner::start_and_recover(..) -> (output, Checkpoint)`;
  `Config::new().with_seed(..).with_rng(..)`; `Context::auditor().state()` gives a determinism-audit string,
  `Context::storage_audit()` a digest; `Context` implements `Spawner`, `Clock`, `Network`, `Storage`, `Resolver`, RNG traits
  (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/runtime/src/deterministic.rs).
  Docs example: `deterministic::Runner::default().start(|context| async move { ... })`.
- `tokio` (https://raw.githubusercontent.com/commonwarexyz/monorepo/v2026.9.0/runtime/src/tokio/mod.rs):
  "production-focused runtime based on Tokio with secure randomness and storage backed by
  the local filesystem"; `tokio::Runner::default().start(|context| async move { ... })`;
  holds an advisory lock on the storage directory's `.hold` file during a run.

## 6. Bonsai / zk-pari / private payments in commonwarexyz

- No Rust code for Bonsai, ZK-PARI, or private payments exists in the monorepo. A recursive
  tree listing of `main` (`28a78b99`, 1862 entries,
  https://api.github.com/repos/commonwarexyz/monorepo/git/trees/main?recursive=1) matches
  `bonsai|pari|payment|private` only under `docs/`: `docs/blogs/private-payments.{md,html,css,counter.js,rpc.js,sim.js}`,
  `docs/blogs/batch-pari.{md,html}`, and images. Top-level crates are: actor, broadcast,
  codec, coding, collector, conformance, consensus, cryptography, deployer, glue, math, p2p,
  parallel, resolver, runtime, storage, stream, utils. The v2026.9.0 sitemap likewise has
  no such code paths (https://commonware.xyz/sitemap.xml).
- PR #4768 "adds bonsai eprint link" (merged 2026-09-14T17:24:56Z, merge commit
  `aa76a0226821c2645ebd3bc5010003e61ef98b0c`, https://github.com/commonwarexyz/monorepo/pull/4768)
  only removed `docs/artifacts/bonsai.pdf` and re-pointed the blog to the eprint.
- Blog "Out of Sight, Out of State" (2026-09-12, Guru Vamsi Policharla, https://commonware.xyz/blogs/private-payments)
  introduces Bonsai: 256-byte operation payload, >1M ops/s verified on an M5 MacBook Pro, one 32-byte commitment
  per account, offline wallets. Prototype: "Our prototype uses Pari with batch verification",
  https://github.com/guruvamsi-policharla/zk-pari/pull/2.
- Paper: "Bonsai: Scalable Private Payments", Patrick O'Grady, Lucas Meier, Guru-Vamsi
  Policharla (Commonware, Inc.), IACR ePrint 2026/1987, received 2026-09-12
  (https://eprint.iacr.org/2026/1987). The ePrint page lists no implementation URL.
- External repo `guruvamsi-policharla/zk-pari` ("A Rust implementation of the Garuda and
  Pari SNARKs", no license field on GitHub, `main` HEAD `3db79adc665f354d7bb7fa22545697452768fe13`
  dated 2026-06-10, https://github.com/guruvamsi-policharla/zk-pari). PR #2 "Adds zk and
  send/receive circuits" is OPEN, not merged, head `a8266aac58314214552a214fead1c0258f8de418`
  (https://github.com/guruvamsi-policharla/zk-pari/pull/2).
- Earlier blog "The Proof is in the Pairing" (2026-03-24, https://commonware.xyz/blogs/batch-pari)
  covers batch PARI verification (60x at 2^16 proofs) and links
  https://github.com/guruvamsi-policharla/garuda-pari/pull/1, which the GitHub API now reports as "Moved Permanently".
- Org repos (https://api.github.com/orgs/commonwarexyz/repos): monorepo, benchmarks, alto,
  battleware, constantinople, simple-bte, monorepo-patches; none is a private-payments codebase.

## 7. Recommended crate set for the ledger

| Need | Crate / path | Notes |
|---|---|---|
| Receipt MMR | `commonware-storage` `merkle::mmr::{mem, full}` + `merkle::Proof` | in-memory for tests, `full` for disk |
| Journal / KV | `commonware-storage` `journal::contiguous::{fixed,variable}`, `qmdb::any`, `metadata` | `qmdb` if state root is needed |
| Consensus | `commonware-consensus` `simplex::{Engine, config::Config, scheme::*}` + `marshal` | `bls12381_threshold` for threshold certs |
| Networking | `commonware-p2p` | `Engine::start` needs three `(Sender, Receiver)` pairs |
| Runtime | `commonware-runtime` `deterministic` (tests), `tokio` (nodes) | seeded, auditable |
| Hashing / keys | `commonware-cryptography` | `Sha256`, ed25519, BLS12-381 used by simplex schemes |
| Wire format | `commonware-codec` | required by journal `variable` and proofs |
| Helpers | `commonware-utils` | `channel::oneshot` used by `Automaton` |

Pin all to `= "2026.9.0"` (tag `v2026.9.0`, commit `d476a236`), Rust >= 1.95.0.

## Unverified

- MSRV 1.95.0 is taken from the workspace `Cargo.toml` at the tag; crates.io metadata shows
  no `rust_version`, and per-crate overrides were not checked for every crate.
- Full argument lists of `Mem::root/proof`, `Merkle::root/proof`, and the `qmdb` batch
  `write`/`merkleize` methods were seen only as grep hits; confirm on docs.rs before coding.
- `Automaton` appears to have no `genesis` method in 2026.9.0 (docs.rs lists only `propose`
  and `verify`; lib.rs grep found none). Treat as absent until confirmed.
- The `garuda-pari` redirect target was not followed (assumed to be `zk-pari`).
- The MCP server was described from its README and landing page only, never connected.
- zk-pari PR #2 was not built or reviewed; only its existence, open state, and head SHA were checked.
- `docs/blogs/private-payments.sim.js` / `.rpc.js` were not read; they are blog assets, not Rust ledger code.
