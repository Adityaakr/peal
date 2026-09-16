# Peal Links operations

How to run, reset and inspect the local stack, and what each process is. Docker is not used on the build machine (decision 0006); compose files, when added, are documentation until exercised.

## Processes

| Process | Command (from `scripts/peal-links/stack.sh`) | Port | State |
|---|---|---|---|
| anvil A (local chain A, chain id 31337) | `anvil --port 8545 --chain-id 31337 --block-time 1` | 8545 | in memory; reset on restart |
| anvil B (local chain B, chain id 31338) | `anvil --port 8546 --chain-id 31338 --block-time 1` | 8546 | in memory |
| Peal Links node | `target/release/peal-links-node --config config/peal-links.local.json` | 8790 | `.dev-state/peal-links/data/ledger-<ns>.sqlite` per namespace, `links.sqlite` for product data |
| explorer (vite dev) | `pnpm -C packages/explorer dev --port 5173` | 5173 | none |

Proving keys: `.dev-params/` (`op.pk` 30 MB uncompressed, `op.vk`, `deposit.pk`, `deposit.vk`, `circuit-id`), generated on the node's first start in about a second, never committed. Deleting the directory regenerates a **different** setup, which invalidates every wallet and ledger made under the old circuit id: reset the data directory at the same time.

## One command

`scripts/peal-links/demo.sh` brings the stack up from a clean checkout (installs, wasm build, Playwright browser if missing) and drives the SDK bridge flow and the two-context browser flow with real proofs and real chain transactions. Non-zero exit on any failure.

## Commands

```
scripts/peal-links/stack.sh up       # build the node (release), start everything, wait for health
scripts/peal-links/stack.sh status   # pids and the node's status document
scripts/peal-links/stack.sh logs     # tail every log under .dev-state/peal-links/logs
scripts/peal-links/stack.sh down     # stop everything started here
scripts/peal-links/stack.sh reset    # down, wipe ledger + product state, up
```

Development fixture: `PEAL_LINKS_DEV_MINT=1 scripts/peal-links/stack.sh up` mounts `POST /links/v1/dev/mint`, which credits a registered deposit intent without a chain event. It is labelled in the node log, in `GET /links/v1/status` (`dev_mint: true`) and in the app ("Add test funds (dev mint)"), refuses to start with a mainnet namespace configured, and is replaced by the watcher in Phase D.

## Compose and the edge (prepared, not exercised here)

- `docker/Dockerfile.links` builds the node image; `docker/docker-compose.links.yml` runs anvil A and B, a one-shot `bootstrap` that places the contracts and writes the node config, the node, and the explorer dev server. Docker was not available on the build machine, so these files are documentation until someone runs `docker compose -f docker/docker-compose.links.yml up --build` and records the result in BUILD_STATUS.md.
- Edge: both Caddyfiles route `/links/*` to the node (`LINKS_UPSTREAM`, default `links:8790` in the production compose and `127.0.0.1:8790` for the standalone explorer). The vite dev server proxies `/links` to `LINKS_URL` (default `http://localhost:8790`).
- Profiles: `config/peal-links.profiles.example.json` carries Ethereum, Base and Arbitrum mainnet and testnet namespaces with empty addresses and `enabled: false`. The node validates the file (`peal-links-node --config config/peal-links.profiles.example.json` loads it and stops only at creating `/var/lib/peal-links`). A namespace becomes available only after the watcher verifies chain id and contract code against its RPC; the signer fixture and the dev-mint flag are refused when any namespace is `mainnet`.

## Health and status

- `GET /healthz` on the node: liveness.
- `GET /links/v1/status`: version, circuit id, setup (`local-dev` or `ceremony`), ledger mode, namespaces with `available`, per-ledger `seq`, `receipt_count`, `state_root`, `receipt_root`.
- `GET /links/v1/ledger/{ns}`: the recent-root window and minted total.
- `GET /links/v1/ledger/{ns}/history?from=&limit=`: the public operation log, replayable.

## Tests

| What | Command | Needs |
|---|---|---|
| Core crate (Gate A) | `cargo test -p peal-bonsai --release` | nothing |
| Node unit tests | `cargo test -p peal-links-node --release` | nothing |
| SDK flow (two wallets, wasm proofs, live node) | `pnpm -C packages/links test` | stack up with `PEAL_LINKS_DEV_MINT=1` |
| Browser flow (two contexts) | `pnpm -C packages/explorer test:e2e` | stack up with `PEAL_LINKS_DEV_MINT=1` |
| Screenshots | `pnpm -C packages/explorer shots` | explorer up |
| Lint and types | `cargo clippy --workspace --all-targets -- -D warnings`, `pnpm -r typecheck` | nothing |

## Data and backups

- Ledger state is one sqlite file per namespace in WAL mode with `synchronous=FULL`; copying the file while the node runs is not a consistent backup. Stop the node or use `sqlite3 .backup`.
- Wallet state lives in the user's browser (IndexedDB, encrypted under a storage key that is itself wrapped by the passphrase). The node holds no wallet state; the only recovery path is the user's exported backup.
- Product data (`links.sqlite`) holds sessions, request manifests, inbox ciphertexts and deposit intents. Nothing in it opens a receipt or moves funds.

## Logs and secret redaction

The node logs operation counts, batch sizes and timings, never envelopes, proofs, openings or session tokens. Request bodies are not logged. arkworks tracing is disabled at the filter (it emits a span per constraint).
