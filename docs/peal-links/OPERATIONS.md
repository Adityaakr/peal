# Peal Links operations

How to run, reset and inspect the local stack, and what each process is. Docker is not used on the build machine (decision 0006); compose files, when added, are documentation until exercised.

## Processes

| Process | Command (from `scripts/peal-links/stack.sh`) | Port | State |
|---|---|---|---|
| anvil A (local chain A, chain id 31337) | `anvil --port 8545 --chain-id 31337 --block-time 1` | 8545 | in memory; reset on restart |
| anvil B (local chain B, chain id 31338) | `anvil --port 8546 --chain-id 31338 --block-time 1` | 8546 | in memory |
| Peal Links node (single-node mode) | `target/release/peal-links-node --config config/peal-links.local.json` | 8790 | `.dev-state/peal-links/data/ledger-<ns>.sqlite` per namespace, `links.sqlite` for product data |
| Peal Links validators (`PEAL_LINKS_VALIDATORS=3`) | `target/release/peal-links-node --config .dev-state/peal-links/config-<i>.json`, one process per validator | 8790, 8791, 8792 (API); 9790, 9791, 9792 (p2p) | `.dev-state/peal-links/data/v<i>/` per validator: the ledgers, `consensus.sqlite` (applied blocks and head), `consensus/` (the engine's journal), `links.sqlite` (that node's product data) |
| explorer (vite dev) | `pnpm -C packages/explorer dev --port 5176` | 5176 (the local test stack; the Sepolia explorer is the default at 5173) | none |

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
scripts/peal-links/stack.sh consensus  # validator mode: height, head and state root per validator
```

Validator mode (decision 0010): `PEAL_LINKS_VALIDATORS=3 scripts/peal-links/stack.sh reset` runs the ledger as a three-validator Commonware simplex set. The script generates one ed25519 key per validator (`peal-links-node --keygen`, kept under `.dev-state/peal-links/validators/`, never committed), writes one config per validator with the full validator set and p2p address book, gives each validator one of the three settlement keys (`signer_key_file`, `signer_addresses`, threshold 2), and starts the three processes. The explorer and the tests use validator 0; any validator serves the same ledger. `scripts/peal-links/stack.sh consensus` prints every validator's height, head digest and applied state root, which must agree. `GET /links/v1/consensus` on any validator returns its view with every ledger's summary. Withdrawals: the validator asked for a certificate signs with its own key and gathers the rest over the validator network; each peer re-checks the claim against its own replicated ledger and its own RPC before signing (`signer_mode: one-key-per-validator`). Both the fixture and this mode are local processes on one machine, not independent operators.

Development fixture: `PEAL_LINKS_DEV_MINT=1 scripts/peal-links/stack.sh up` mounts `POST /links/v1/dev/mint`, which credits a registered deposit intent without a chain event. It is labelled in the node log, in `GET /links/v1/status` (`dev_mint: true`) and in the app ("Add test funds (dev mint)"), refuses to start with a mainnet namespace configured, and is replaced by the watcher in Phase D.

## Public testnets (Ethereum Sepolia, Tempo Moderato)

`NETWORK=sepolia|tempo scripts/peal-links/testnet.sh deploy|up|down|status` runs the same node against a public testnet, one network per invocation: `deploy` puts the gateway and the faucet test token on chain from the deployer key in `.dev-state/peal-links/sepolia-deployer.key` (one key, the same address on every chain; never in git), generates that network's settlement fixture and writes `.dev-state/peal-links/<network>/config.json` from `config/peal-links.<network>.json`; `up` starts a single-node instance and an explorer next to the local stack (Sepolia: node :8795, explorer :5173, which is the default explorer a person opens, with Circle's testnet USDC as the first namespace; Tempo: node :8796, explorer :5175). The local anvil stack's explorer is at :5176, which is what the browser suites use by default. The browser suite runs against either with `LINKS_URL`, `EXPLORER_URL` and `FUNDER_KEY=<deployer key>`.

- Sepolia: testers need Sepolia ETH for gas; blocks are 12 s apart, so a funding leg at checkout takes about 30 to 40 s (`confirmations: 2`).
- Tempo Moderato (chain 42431): gas is the PathUSD token and the chain funds any address through the `tempo_fundAddress` RPC method, which the app calls for a wallet that holds none (`ensureGas` in the SDK); its gas estimator is an order of magnitude low and it rejects transactions above 30M gas, so every write on it carries an explicit 29M limit (`TX_GAS`), and deployment uses `forge create` with the same limit; blocks are about half a second apart (`confirmations: 10`, about 5 s).

The status document carries each namespace's `rpc_url` so a client can read the chain and call a gas faucet without a wallet.

## Compose and the edge (prepared, not exercised here)

- `docker/Dockerfile.links` builds the node image; `docker/docker-compose.links.yml` runs anvil A and B, a one-shot `bootstrap` that places the contracts and writes the node config, the node, and the explorer dev server. Docker was not available on the build machine, so these files are documentation until someone runs `docker compose -f docker/docker-compose.links.yml up --build` and records the result in BUILD_STATUS.md.
- Edge: both Caddyfiles route `/links/*` to the node (`LINKS_UPSTREAM`, default `links:8790` in the production compose and `127.0.0.1:8790` for the standalone explorer). The vite dev server proxies `/links` to `LINKS_URL` (default `http://localhost:8790`).
- Profiles: `config/peal-links.profiles.example.json` carries Ethereum, Base and Arbitrum mainnet and testnet namespaces with empty addresses and `enabled: false`. The node validates the file (`peal-links-node --config config/peal-links.profiles.example.json` loads it and stops only at creating `/var/lib/peal-links`). A namespace becomes available only after the watcher verifies chain id and contract code against its RPC; the signer fixture and the dev-mint flag are refused when any namespace is `mainnet`.

## Health and status

- `GET /healthz` on the node: liveness.
- `GET /links/v1/status`: version, circuit id, setup (`local-dev` or `ceremony`), ledger mode (`single-node` or `simplex-N-validators`), the validator's consensus view when replicated, signer mode, namespaces with `available`, per-ledger `seq`, `receipt_count`, `state_root`, `receipt_root`.
- `GET /links/v1/consensus` (validator mode): validator id, validator set, height, head digest, applied state root, genesis, mempool size, and every ledger's summary.
- `PUT /links/v1/directory`, `GET /links/v1/directory/{ns}/{address}` (session-bound, 60 lookups per minute per session): signed receiving profiles (decision 0013). `PUT /links/v1/backups/{ns}`, `GET /links/v1/backups/{ns}` (session-bound): encrypted backups, last 8 versions per wallet, lower state versions refused.
- `GET /links/v1/ledger/{ns}`: the recent-root window and minted total.
- `GET /links/v1/ledger/{ns}/history?from=&limit=`: the public operation log, replayable.

## Tests

| What | Command | Needs |
|---|---|---|
| Core crate (Gate A) | `cargo test -p peal-bonsai --release` | nothing |
| Consensus crate (four simulated validators on the deterministic runtime) | `cargo test -p peal-links-consensus` | nothing |
| Node unit tests | `cargo test -p peal-links-node --release` | nothing |
| SDK flows (two EVM wallets: setup, deposit, link, approve and pay, pay an address, recover on a fresh device; bridge) | `pnpm -C packages/links test` | stack up (real deposits; no dev mint) |
| Browser: the one-wallet acceptance criteria (addendum section 10) | `pnpm -C packages/explorer exec playwright test e2e/links-one-wallet.spec.ts` | stack up; do not edit files under `packages/` while it runs (the vite dev server reloads the page) |
| Browser: edge cases (terminal states, declining wallet, wrong network, concurrent payer, keyboard) | `pnpm -C packages/explorer exec playwright test e2e/links-edge.spec.ts` | stack up |
| Screenshots | `pnpm -C packages/explorer shots` | explorer up |
| Lint and types | `cargo clippy --workspace --all-targets -- -D warnings`, `pnpm -r typecheck` | nothing |

## Data and backups

- Ledger state is one sqlite file per namespace in WAL mode with `synchronous=FULL`; copying the file while the node runs is not a consistent backup. Stop the node or use `sqlite3 .backup`.
- Wallet state lives in the user's browser (IndexedDB, encrypted under a storage key that is itself wrapped by the passphrase). The node holds no wallet state; the only recovery path is the user's exported backup.
- Product data (`links.sqlite`) holds sessions, request manifests, inbox ciphertexts, deposit intents, the directory (which wallet address authorized which private account) and encrypted backups. Nothing in it opens a receipt or moves funds; the directory is the one place the wallet-to-account association is stored in clear (THREAT_MODEL.md observer matrix).

## Logs and secret redaction

The node logs operation counts, batch sizes and timings, never envelopes, proofs, openings or session tokens. Request bodies are not logged. arkworks tracing is disabled at the filter (it emits a span per constraint).
