# Peal Links build status

Living log. Read this first every session. Spec: `SPEC.md`.

## Current phase: G (one wallet, private by default), complete on 2026-09-16; F complete including the validator-mode addendum

### Smoke command
```
cargo test -p peal-bonsai --release
```
Expected: 7 passed, 0 failed (encoding 2, gate_a 3, parity 2), about 12 s including keygen.

### Environment (build machine, 2026-09-16)
- Apple M5, 10 cores, 24 GiB. macOS 25.4. Rust 1.97.0, Node 22.23.2, pnpm 11.9.0, wasm-pack present, wasm32-unknown-unknown target installed.
- Foundry 1.6.0 at `~/.foundry/bin` (not on PATH by default). `just` installed via brew.
- Docker is NOT installed. Compose files are prepared but the local stack runs under `scripts/peal-links/stack.sh` (process manager script, logs and pids under `.dev-state/peal-links/`).
- Playwright 1.63 with Chromium installed as an explorer dev dependency (`pnpm -C packages/explorer shots` takes the evidence screenshots; `test:e2e` runs the flow tests once they exist).

### Phase A plan
1. Repository discovery: explorer is a vanilla-TS SPA with hash routing (`packages/explorer/src/main.ts`), one React island (landing), Privy auth (`auth.tsx`), Tailwind only on the landing island, coordinator axum API on `/v0` + `/v1` with rusqlite. Design tokens in `packages/explorer/src/style.css` (`--accent #2563eb`, `--text #111827`, `--muted #6b7280`, `--border #e5e7eb`, Josefin Sans display, Satoshi/DM Sans body). DONE.
2. Upstream smoke: zk-pari PR #2 head `a8266aac…` builds and passes `cargo test --release --features circuits` (31 passed, 0 failed, 1 ignored). Evidence: `evidence/phase-a-upstream-zkpari-tests.log`. DONE.
3. Research notes from subagents in `research/` (Bonsai sources, Commonware library). Then write `RESEARCH.md` with the operation-to-file mapping and the missing integration pieces.
4. Decisions: hash backend (Poseidon), tree depths, account identity, namespace binding, deposit relation, withdrawal relation, settlement trust, storage. Recorded in `decisions/`.
5. New crate `crates/peal-bonsai`: pin `zkpari` as a git dependency at the revision above; Peal parameters; wallet state (opening, SMT, journal); ledger STF (accounts, receipt tree, root window) over rusqlite; verifier path with canonical decoding; tests for Gate A.
6. Gate A: genuine send and claim plus an invalid proof rejected, on the persistent ledger, replayable after reopen.
7. THREAT_MODEL.md observer matrix (first version) and ARCHITECTURE.md (first version).

### Gate table
| Gate | Status | Commit | Evidence |
|---|---|---|---|
| A | PASSED | 06703bf | evidence/gate-a-tests.log, evidence/phase-a-upstream-zkpari-tests.log |
| B | PASSED | (see record) | evidence/phase-b/*.png |
| C | PASSED | (see record) | evidence/phase-c/ |
| D | PASSED | (see record) | evidence/phase-d/ |
| E | PASSED | (see record) | evidence/phase-e/ |
| F | OPEN | | |

### Blockers

### Blocker: trusted setup provenance
Blocked: production proving and verifying keys for R_op and R_dep.
Reason: ZK-Pari has a per-circuit trusted setup; the only keys that exist are generated in one process by `Keys::generate` (trapdoor discarded in memory). No ceremony has been run.
Done instead: `Keys::load_or_generate` writes keys to a local params directory (gitignored `.dev-params/`), labeled "local development setup" in the node's status endpoint and the UI.
Isolation: keys are never committed; the node refuses to start in a `production` profile without a params directory whose circuit id matches the configured one (Phase F check).
Unblock requirement: a multi-party ceremony for both circuits at the pinned revision, published transcripts, and the resulting circuit id pinned in configuration.

### Blocker: simulation extractability of ZK-Pari
Blocked: a security argument for the payment protocol as deployed.
Reason: paper Remark 2 defers the simulation-extractability proof the payment protocol relies on; no later work found (2026-09-16).
Done instead: nothing can be done locally; recorded in RESEARCH.md, THREAT_MODEL.md and MAINNET_READINESS.md.
Isolation: not applicable (property of the scheme).
Unblock requirement: a published proof, or a reviewed transformation to a simulation-extractable variant, adopted upstream.

### Blocker: Docker not available on the build machine
Blocked: docker compose based local stack.
Reason: `docker` is not installed; installing a system daemon is outside this run.
Done instead: `scripts/peal-links/stack.sh` process manager (Phase C), compose files prepared but untested here.
Isolation: compose files are documentation until exercised; OPERATIONS.md says which path is tested.
Unblock requirement: run `docker compose -f docker/docker-compose.links.yml up` on a machine with Docker and record the result.

### Decisions
(see `decisions/`)

### Gate A: discover and prove the foundation  [PASSED]
Commit: 06703bf
Commands:
- upstream smoke at rev a8266aac: `cargo test --release --features circuits` -> exit 0 (31 passed, 0 failed, 1 ignored)
- `cargo test -p peal-bonsai --release` -> exit 0
- `cargo clippy -p peal-bonsai --all-targets -- -D warnings` -> exit 0; `cargo fmt -p peal-bonsai` clean
Tests: peal-bonsai 7/0/0 (encoding 2, gate_a 3, parity 2); zkpari upstream 31/0/1
Artifacts: evidence/gate-a-tests.log, evidence/phase-a-upstream-zkpari-tests.log
What the gate proves: on a sqlite-backed ledger, a mint receipt is claimed by a genuine R_op receive proof, a genuine R_op send creates a receipt that a second account (offline during the send, path served later against the current root) verifies and claims; tampered proofs, redirected receipts, foreign namespaces, wrong roots, unknown accounts, replays (stale commitment), overdrafts and wrong-recipient claims are rejected by the STF; a batch with one bad proof isolates it and resolves a same-state race by order; the store reopens to the same state root and a full replay re-verifies every proof; wallet crash recovery reconciles from the ledger commitment alone.
Measured: R_op 51,791 SR1CS constraints (domain 2^16); native multi-threaded prove 0.5 to 0.8 s; keygen 0.66 s (Apple M5, release).
Residual risks: single-node ledger (no consensus yet); locally generated setup; simulation extractability unproven; no EVM side yet; wallet persistence is plain JSON until the SDK encrypts it (Phase C); the receipt tree is fixed-depth (as upstream), not an MMR.

### Phase B plan
1. Playwright for screenshots (dev dependency of the explorer, chromium only).
2. Landing `#/bonsai` in the existing page style (Josefin Sans display, DM Sans body, accent #2563eb): hero "One link. A private payment.", illustrative checkout preview with fictional data, request/pay/receive explanation, three use cases, privacy explanation from THREAT_MODEL.md, developer section referencing the SDK surface that exists, FAQ, Commonware/Bonsai attribution.
3. App shell `#/bonsai/app`: header, balances per namespace, requests list, activity list, empty states; every data-bearing element reads from a `LinksClient` interface whose only implementation is the real node client (no fixture data), and shows "services not connected" until Phase C.
4. Checkout shell `#/pay/<id>`: manifest display, statuses, error states; same rule.
5. "payments" nav entry; `PAGE_PATHS` and `pages.rs` entries for `bonsai`, `bonsai/app`, `pay`.
6. Screenshots at 390, 820, 1280 px, inspected, fixed; existing routes re-checked.
Gate B evidence: screenshots under evidence/phase-b/, typecheck and build green.

### Gate B: design and navigation  [PASSED]
Commit: see the commit that adds this record (peal-links(phase-b))
Commands:
- `pnpm -C packages/explorer exec tsc --noEmit` -> exit 0
- `cargo check -p bte-coordinator` -> exit 0 (page table entries `bonsai`, `bonsai/app`)
- `pnpm -C packages/explorer shots` (Playwright, vite dev on :5173, node not running) -> 21 passed; asserts no horizontal overflow and no page errors at 390, 820 and 1280 px on landing, app, checkout (valid and invalid id), home, mempool landing, developers
Tests: explorer screenshots 21/0/0
Artifacts: evidence/phase-b/{landing,app,pay,pay-bad-id,home,mempool-landing,developers}-{phone,tablet,desktop}.png
Inspected and fixed: below-the-fold sections not revealed in captures (spec now scrolls before capture); vite proxy 500 shown as a raw status (non-JSON errors now read as "unreachable"); preview footer wrapping at 390 px; three-column privacy table at 390 px (now stacked with labels).
Routes: `#/bonsai` (also `/bonsai`), `#/bonsai/app` (also `/bonsai/app`), `#/pay/<24-char id>` (also `/pay/<id>`); "payments" entry in the header menu. Existing routes re-captured unchanged.
Residual risks: the app and checkout pages only show their populated states with the node running (Phase C); no active control can move funds yet and none is rendered as if it could; checkout `noindex` and `referrer` meta are set at render time only (prerender for the coordinator-served shell comes with Phase E).

### Phase C plan (reordered: consensus after the end-to-end flow)
1. `crates/peal-links-node`: axum on :8790. `/links/v1/status`; per-namespace ledger API (roots, account, register, ops, receipt paths, params by digest); product API (SIWE-style session auth via EIP-191 + nonce + expiry, signed request manifests, listing by session); inbox (bind encryption key to account, post ciphertext, fetch with account signature). sqlite: `ledger-<ns>.sqlite` per namespace and `links.sqlite` for product data.
2. `crates/peal-links-wasm`: wasm-bindgen wallet (create, register, prepare/prove send, receive, deposit; commit/abort/reconcile; x25519 + XChaCha20-Poly1305 receipt envelopes; argon2id + XChaCha20-Poly1305 backups), built single-threaded, inlined like `packages/sdk`.
3. `packages/links`: typed SDK (node client, wallet in a Web Worker for proving, IndexedDB persistence, request manifests, inbox, backup export/import), with vitest tests against the running node.
4. Explorer: onboarding (Privy connect, SIWE session, create or restore private account with passphrase), dashboard with real balances and receipts, request creation with QR and copy link, checkout paying with real proofs, inbox auto-claim under a session preference, backup export and import.
5. `scripts/peal-links/stack.sh` (node + explorer for now; anvil chains join in Phase D).
6. Gate C: two browser contexts, recipient creates a link, payer (funded via a labelled local mint endpoint that is removed in Phase D when real deposits exist) pays, receiver offline during the send claims later; Playwright test.
7. Commonware simplex multi-node ordering: scheduled after Gate E; recorded as a blocker until then.

### Gate C: wallet and private ledger  [PASSED, with consensus deferred]
Commit: see the commit that adds this record (peal-links(phase-c): gate C)
Commands:
- `cargo test -p peal-bonsai --release` -> exit 0 (11 passed: lib 6, gate_a 3, parity 2)
- `cargo test -p peal-links-node --release` -> exit 0 (2 passed)
- `cargo clippy -p peal-bonsai -p peal-links-node --all-targets -- -D warnings` -> exit 0
- `pnpm -C packages/links test` (vitest, live node with PEAL_LINKS_DEV_MINT=1) -> exit 0 (1 passed; evidence/phase-c/sdk-e2e-vitest.log)
- `pnpm -C packages/explorer test:e2e e2e/links-flow.spec.ts` (Playwright, two contexts) -> exit 0 (1 passed in 30.5 s; evidence/phase-c/links-flow-playwright.log)
- `pnpm -C packages/links typecheck`, `pnpm -C packages/explorer exec tsc --noEmit` -> exit 0
Tests: peal-bonsai 11/0/0; peal-links-node 2/0/0; peal-links (vitest) 1/0/0; explorer Playwright flow 1/0/0
Artifacts: evidence/phase-c/01..09-*.png (inspected: account creation, link with QR, checkout at 390 px, funds needed, funded, proving, accepted, receiver unclaimed, receiver claimed), evidence/phase-c/*.log
What the gate proves: two separate browser contexts drive the real stack. The receiver creates a private account (keys in the browser, encrypted under a passphrase, registered on the ledger with a signed envelope), signs in with an EVM wallet (EIP-4361 message, EIP-191 recovery on the node), publishes a signed request manifest, and goes offline. The payer opens the link, the manifest signature is verified in wasm before the amount is trusted, a private account is created, test funds are credited through the labelled dev-mint fixture (R_dep proof, intent, mint, claim proof), the payment is proved in a Web Worker (R_op send, ~7 s), accepted by the ledger STF, and the receipt opening is encrypted to the receiver's x25519 key and posted to the inbox. A reload after paying keeps the payer's reservation and shows "paid from this device" instead of offering to pay again. The receiver returns in a new tab, unlocks, the inbox is decrypted locally, the receipt is verified against a served path and root, claimed with a receive proof, the balance updates, and the receiver's signed acknowledgement marks the request fulfilled. The SDK test additionally covers backup export and restore on a fresh store, a stale-device conflict, and crash reconcile.
Measured: single-threaded wasm R_op proof 6.4 to 6.7 s in Node (V8), faster in Chromium (three proofs plus everything else in 30 s); R_dep 0.3 s; proving-key load 0.7 s (30 MB uncompressed, digest-checked, cached in IndexedDB).
Residual risks: single-node ledger (Commonware simplex integration deferred, see blocker); the on-chain funding leg is the dev-mint fixture until Phase D; the inbox is public-write (spam is bounded by size and rate, not identity); one-time requests are a soft lock, not ledger admission (documented weaker behaviour, decision 0004/SPEC section 8); no Playwright coverage yet of wrong-network, wallet rejection or quote expiry (Phase E).

### Blocker: multi-node consensus  [RESOLVED LOCALLY, 2026-09-16]
Was blocked: decentralised ordering of ledger operations.
Done: `crates/peal-links-consensus` implements the `Automaton`/`Relay`/`Reporter` application over `commonware_consensus::simplex` (crates pinned `=2026.9.0`) with the ledger STF as the block executor (decision 0010); `PEAL_LINKS_VALIDATORS=3 scripts/peal-links/stack.sh reset` runs three local validators; Gates C to E suites pass against them (Gate F addendum below).
Still open (MAINNET_READINESS.md): validators on separate machines under independent operators, validator key custody, dynamic sets, `marshal` for durable ordered delivery. The default local stack remains `single-node`; `ledger_mode` reports which mode runs.

### Blocker: development mint fixture
Blocked: real on-chain funding of a private balance.
Reason: the gateway contract exists and is tested (contracts/src/links, 9 Foundry tests) but the watcher and the deposit UI are Phase D work in progress.
Done instead: `POST /links/v1/dev/mint` behind `PEAL_LINKS_DEV_MINT=1`, labelled everywhere it appears (decision 0008).
Isolation: default-off config flag; refuses to start with a mainnet namespace.
Unblock requirement: Phase D watcher credits intents from finalized `Deposit` events on both local chains; the flag is dropped from the stack script and the tests.

### Phase D plan
1. `crates/peal-links-node/src/evm.rs`: JSON-RPC client (chain id, block number, block hash, logs, code, call).
2. `watcher.rs`: per enabled namespace, verify chain id and gateway code, poll `Deposit` logs from a persisted cursor, credit intents at `confirmations` depth with `deposit_id = chain:tx:logIndex`, detect reorgs by block hash and rewind; mark namespaces `available` only after verification.
3. `settlement.rs`: EIP-712 digest matching `PealLinksGateway.withdrawalDigest` (cross-checked by a Foundry test with `deployCodeTo`), consumed-position table, certificate assembly from configured signer keys (local fixture: three keys in one process, labelled), `Withdrawn` observation.
4. `withdrawal.rs` (core) done: burn identifier, signed disclosure, wallet `prepare_withdrawal` and `withdrawal_claim`.
5. Stack: deploy gateway + demo token on both anvil chains, write `.dev-state/peal-links/config.json` with addresses and `enabled: true`, mint demo tokens to anvil accounts; drop `PEAL_LINKS_DEV_MINT`.
6. SDK and explorer: `approve` + `deposit` through the connected wallet (viem over EIP-1193), deposit status polling, withdraw dialog (amount, recipient), certificate polling and `withdraw` submission, chain-specific status lines.
7. Tests: watcher unit tests (dedup, restart, reorg) with an RPC trait double in narrow unit tests only; SDK flow with real anvil deposits and withdrawals on both chains and cross-domain isolation; Foundry digest cross-check; Playwright flow extended with a real deposit and a withdrawal.
Gate D evidence: token balances on anvil before and after, ledger minted/withdrawn totals reconciled against gateway reserves.

### Gate D: funding and withdrawals  [PASSED]
Commit: see the commit that adds this record (peal-links(phase-d): gate D)
Commands:
- `cd contracts && forge test` -> exit 0 (124 passed, 0 failed; 10 of them for Peal Links: `test/links/PealLinksGateway.t.sol` 9, `test/links/Digest.t.sol` 1)
- `cargo test -p peal-links-node --release` -> exit 0 (6 passed: SIWE parse, EIP-191 recovery, deposit log decode, topic hashes, digest stability, fixture signer address)
- `cargo test -p peal-bonsai --release` -> exit 0 (11 passed)
- `cargo clippy -p peal-bonsai -p peal-links-node -p peal-links-wasm --all-targets -- -D warnings` -> exit 0
- `scripts/peal-links/stack.sh reset` (two anvil chains, gateway + TestUSD on each, node with watcher and signer fixture) -> both namespaces `available: true` after the watcher verified chain id and code
- `pnpm -C packages/links exec vitest run test/bridge.test.ts` -> exit 0 (1 passed, 52 s; evidence/phase-d/bridge-vitest.log)
- `pnpm -C packages/explorer test:e2e e2e/links-flow.spec.ts` (real deposit path, no dev mint) -> exit 0 (1 passed, 38 s; evidence/phase-d/links-flow-playwright.log)
Tests: forge 124/0/0; peal-links-node 6/0/0; peal-bonsai 11/0/0; peal-links vitest 2/0/0 (e2e + bridge); explorer Playwright 1/0/0
Artifacts: evidence/phase-d/bridge-vitest.log, evidence/phase-d/links-flow-playwright.log, evidence/phase-c/04-payer-needs-funds.png and 05-payer-funded.png (now the real deposit path), evidence/phase-d/bench-ledger.md (ledger benchmark, see BENCHMARKS.md)
What the gate proves: real TestUSD tokens enter `PealLinksGateway` on anvil chain A through `approve` + `deposit(token, amount, rho)` signed by the person's wallet; the node's watcher credits the registered intent exactly once after two confirmations with `deposit_id = 31337:<tx>:<logIndex>`; a second deposit for an already minted receipt is observed and never credited; the credited receipt is claimed with a receive proof, moves privately to a second account, and part of it is burned with a send to the withdraw identifier; the node checks the disclosed opening against the ledger leaf, consumes the position once, and the three-signer fixture (threshold 2) certifies an EIP-712 message whose digest is cross-checked against the contract; the certificate releases tokens to the recipient on chain A, a replay is refused by the contract, the same certificate is refused by chain B's gateway, and the watcher confirms the `Withdrawn` event; `minted - withdrawn` equals the sum of private balances and the gateway reserve covers it. In the browser, the checkout funds a first-time payer from the connected wallet (two wallet transactions) and continues to a real payment.
Residual risks: committee-attested bridge with a single-process signer fixture (documented in decision 0005, THREAT_MODEL.md, MAINNET_READINESS.md); confirmation policy is a block count (Ethereum finality tags and L2 settlement assumptions are not modelled); the gateway owner can rotate signers; watcher unit tests with an RPC double (restart, rewind) are not yet written, the behaviours are exercised only through the live stack; the browser withdrawal step is added to the flow test and runs at the start of Phase E.

### Phase E plan
1. Browser flow: withdrawal from the dashboard (added), reload at every payment stage, wallet rejection, wrong network, expired request, concurrent payer on a one-time request, stale manifest, backup export and restore on a fresh context, incoming-versus-spendable semantics, QR and copy link, keyboard navigation, mobile layout; existing routes re-captured.
2. Reality audit per SPEC section 4 prompt 4: grep for mocks, fixtures, demo flags; network and log capture for private material; existing routes; gate evidence matches commits.
3. Remove the dev-mint fixture from the default configuration (keep the flag for the SDK's Phase C test only, or convert that test to the real deposit path).
4. Explorer polish from inspected screenshots; `.env.example` entries; README section.
5. Watcher unit tests with an RPC double (narrow unit tests only).

## Reality audit (Phase E, 2026-09-16)

1. **Test doubles, fixtures, demo flags** (`grep -rniE 'mock|stub|fixture|todo|fake|unimplemented|demo|skip|dev_mint'` over the Peal Links crates, SDK, pages, contracts, scripts and config; full output in the session log, summarised here):
   - `crates/peal-links-node/src/api.rs` dev-mint endpoint: mounted only when `dev_mint` is on (`PEAL_LINKS_DEV_MINT=1` or config), refused with a mainnet namespace, labelled in the status document, the node log and the app. **Not reachable from the default demo path**: `stack.sh` no longer sets it and both SDK tests and both browser specs fund through real deposits. Blocker record below stays until the endpoint is removed.
   - `crates/peal-links-node/src/settlement.rs` single-process signer committee: **reachable by design in the local demo**, labelled `signer_mode: single-process-fixture` in the status document, in the node log at start, in the withdraw dialog and in every document; refused with a mainnet namespace. Blocker: settlement trust (decision 0005).
   - `packages/explorer/src/pages/bonsai-landing.ts` hero preview: fictional data, labelled "illustration · fictional data" on the card.
   - `MemoryStore` in `packages/links/src/account.ts`: an in-memory `WalletStore` used by Node tests; the explorer uses `indexedDbStore`. Not a fake of anything (storage is an interface).
   - Test tokens (`TestUSD` faucet, anvil public keys): local and test chains only; the faucet is refused on a mainnet namespace by the SDK and the token is never placed by the scripts on one.
   - No `todo!`, `unimplemented!`, `TODO` or skipped tests in the Peal Links code. Verifier paths: `ZkPari::verify` and `batch_verify` only; no hash-check or return-true verifier exists.
2. **Private material on the wire and in logs**: the browser flow captures every request both contexts send to `/links/v1/` and asserts no `spend_seed`, `enc_seed`, `balance`, `claimed`, `pending_deposits`, `sent_openings` or passphrase appears in any body or URL, that inbox posts carry ciphertext without an `amount`, and that operation submissions carry exactly the envelope fields (evidence/phase-d/links-flow-playwright.log). The node log after the full suites contains no hex string of 200 or more characters (no proofs or envelopes are logged) and no `spend_seed`, `enc_seed`, `randomness`, `passphrase` or `"balance"`; the product store's inbox rows contain no `amount` field (ciphertext only). Analytics: none on these routes.
3. **Existing Peal routes**: the screenshot spec captures home, the mempool landing and the developer docs at three widths with no page errors; `pnpm -C packages/explorer build` succeeds (17 prerendered pages, 247 assets) with the new pages included; `cargo test --workspace` and `forge test` run in Phase F.
4. **Gate evidence matches commits**: Gate A `06703bf`; Gates B, C, D recorded in the commits that added them; every artifact path listed exists under `docs/peal-links/evidence/`.

### Gate E: product integration  [PASSED]
Commit: see the commit that adds this record (peal-links(phase-e): gate E)
Commands:
- `pnpm -C packages/explorer test:e2e e2e/links-flow.spec.ts` -> exit 0 (1 passed, 50 s; evidence/phase-e/links-flow-playwright.log): create link, deposit from wallet, pay, reload keeps "paid from this device", receiver claims and acknowledges, receiver withdraws from the dashboard and the tokens land on chain A, privacy assertions on every captured request
- `pnpm -C packages/explorer test:e2e e2e/links-edge.spec.ts` -> exit 0 (5 passed, 1.5 min; evidence/phase-e/links-edge-playwright.log): archived, expired, unknown and malformed request screens; sign-in declined and deposit declined in the wallet; wrong network; reload in the middle of proving with exactly one payment afterwards; concurrent payer held off by the reservation; backup exported from the UI and restored in a fresh browser with balance and claimed receipt; checkout reachable by keyboard
- `pnpm -C packages/links test` -> exit 0 (2 passed: e2e with a real deposit, bridge)
- `pnpm -C packages/explorer build` -> exit 0 (17 prerendered pages, 247 assets)
- `pnpm -C packages/explorer exec tsc --noEmit`, `pnpm -C packages/links typecheck` -> exit 0
Tests: explorer Playwright 6/0/0; peal-links vitest 2/0/0; screenshots 21/0/0 (Phase B spec, re-run in Phase F)
Artifacts: evidence/phase-e/edge-*.png (inspected: the raw wallet and chain errors overflowed the card and were replaced by one-sentence messages, then re-captured), evidence/phase-e/*.log
Residual risks: the one-time request is a ten-minute soft lock, not ledger admission (a second payer after expiry pays again and the receiver holds a duplicate to refund; SPEC section 8 disclosure in decision 0004 and the checkout copy); no Playwright coverage of quote expiry mid-checkout beyond the request expiry screen; the inbox is public-write (bounded by size, not identity); export of a receipt or CSV from the dashboard is not implemented (history is shown, not exported); notifications outside the app are not implemented.

### Phase F plan
1. Workspace-wide checks: `cargo test --workspace --release`, `cargo clippy --workspace`, `forge test`, `pnpm -r typecheck`, screenshot spec re-run with the node up.
2. Clean-checkout run: `git clone` the branch into a temporary directory and run `scripts/peal-links/demo.sh` there (ports shared with the running stack: stop it first).
3. Handoff block in this file per SPEC section 15; MAINNET_READINESS.md final pass.

### Phase F progress
- Workspace checks (evidence/phase-f/workspace-checks.log): `cargo test --workspace --release` exit 0 (bte-coordinator 30 + 50 + 17, bte-crypto 9, bte-node 1, peal-bonsai 12, peal-links-node 6); `forge test` 125 passed; `pnpm -r typecheck` clean; `cargo clippy --workspace --all-targets -- -D warnings` exit 0.
- Deployment artifacts: `docker/Dockerfile.links`, `docker/docker-compose.links.yml` (prepared, not exercised: no Docker here), `/links/*` routes in both Caddyfiles, `config/peal-links.profiles.example.json` (Ethereum, Base, Arbitrum mainnet and testnet namespaces, all disabled; validated by the node's config loader), `.env.example` entries, README section.
- Clean-checkout run: first attempt failed in the browser flow because the explorer imports Peal's existing SDK (`packages/sdk`, built from `crates/bte-wasm`) whose `dist/` is not committed; `demo.sh` now builds it and initialises submodules. Second attempt passed (below).

### Gate F: production preparation and QA  [PASSED]
Commit: `f25229f` (the clone's head) plus the commit that adds this record.
Commands:
- `git clone -b feat/peal-links <repo> peal-clean && cd peal-clean && scripts/peal-links/demo.sh` -> exit 0 in 2 min 22 s wall clock (evidence/phase-f/clean-checkout-demo.log): tooling check, submodules, `pnpm install --frozen-lockfile`, bte-sdk build, wasm-pack build of `peal-links-wasm`, `stack.sh reset` (two anvil chains, gateway and TestUSD on each, node with keygen, watcher and signer fixture, explorer), SDK bridge test 1 passed (52 s), browser flow 1 passed (48 s), final status print
- `cargo test --workspace --release` -> exit 0 (evidence/phase-f/workspace-checks.log)
- `forge test` -> 125 passed, 0 failed
- `cargo clippy --workspace --all-targets -- -D warnings` -> exit 0
- `pnpm -r typecheck` -> exit 0
- `pnpm -C packages/explorer build` -> exit 0 (17 prerendered pages)
Tests: Rust workspace 125/0/0 (all crates); forge 125/0/0; peal-links vitest 2/0/0; explorer Playwright 6/0/0 plus screenshots 21/0/0
Artifacts: evidence/phase-f/clean-checkout-demo.log, evidence/phase-f/workspace-checks.log
What the gate proves: a fresh clone of the branch on a machine with the documented toolchain reaches a working two-chain local stack and drives the complete flow with real proofs, real chain transactions and the labelled signer fixture, with one command and no manual step; every existing workspace check stays green with the new crates, packages and contracts included.
Residual risks: the clean run was performed on the build machine (same toolchain versions as the development run) rather than a second machine; Docker images are prepared but unbuilt; the deployment profiles for public chains are validated for shape only and every public namespace is disabled.

### Gate F addendum: consensus (validator mode)  [PASSED]
Commit: `81036c6` (crate and deterministic tests), `489e898` (node validator mode, three-validator stack), plus the commit that adds this record.
Decision: decisions/0010-simplex-consensus-over-the-ledger.md (Commonware `simplex`, crates pinned `=2026.9.0`; API map in research/commonware-simplex-api.md).
Commands:
- `cargo test -p peal-links-consensus` -> exit 0 (3 unit + 3 integration: `four_validators_agree_on_the_ledger` (registrations at two validators, a mint refused until every validator's chain view confirms it, a real R_dep mint, a receive proof, a send proof submitted to two validators at once, a replayed proof refused as stale, a tampered proof refused, identical ledgers and a replayed state root on all four, application requests answered by all three peers), `three_of_four_validators_finalize_without_the_fourth`, `a_validator_that_missed_blocks_catches_up_by_digest`; deterministic runtime over the simulated network, about 6 s)
- `PEAL_LINKS_VALIDATORS=3 scripts/peal-links/stack.sh reset` -> three validator processes (API 8790..8792, p2p 9790..9792), each with its own ledgers, block store, engine journal and one settlement key; `scripts/peal-links/stack.sh consensus` -> identical height, head digest and applied state root on all three (evidence/phase-f/validators-consensus-restart.txt)
- `pnpm -C packages/links exec vitest run test/bridge.test.ts` against validator 0 -> exit 0 (1 passed, 53 s; evidence/phase-f/validators-bridge-vitest.log): the deposit is credited by a mint that every validator confirmed against its own RPC before voting; the withdrawal certificate carries the requester's signature plus signatures gathered from the two other validators, each logged as "co-signed a withdrawal after checking the replicated ledger"
- `pnpm -C packages/explorer exec playwright test e2e/links-flow.spec.ts` against validator 0 -> exit 0 (1 passed, 60 s; evidence/phase-f/validators-links-flow-playwright.log)
- `PEAL_LINKS_VALIDATORS=3 scripts/peal-links/stack.sh nodes` (stop the three validators, rebuild, start them on the same data) -> all three resume from their persisted ledgers and journals with the same state root and a continuing height (evidence/phase-f/validators-consensus-restart.txt)
- `pnpm -C packages/links test` -> e2e 1 passed (38 s), bridge 1 passed on the rerun after its signature-count assertion was changed from "three signatures" to "at least the threshold" (the distributed committee stops at the threshold; the fixture signs with every key) (evidence/phase-f/validators-sdk-vitest.log, validators-bridge-vitest.log)
- `pnpm -C packages/explorer exec playwright test e2e/links-edge.spec.ts` -> exit 0 (5 passed, 1.6 min; evidence/phase-f/validators-links-edge-playwright.log)
- Clean checkout in validator mode: `git checkout feat/peal-links` in a scratch clone at `8abd11c`, `PEAL_LINKS_VALIDATORS=3 scripts/peal-links/demo.sh` -> exit 0 (bridge 1 passed 53 s, browser flow 1 passed 51 s, status `ledger simplex-3-validators | signers one-key-per-validator`, three validators at height 251 with the same head and state root; evidence/phase-f/clean-checkout-demo-validators.log)
- Fault probe: `scripts/peal-links/stack.sh stop-node 2` -> the two remaining validators stop finalizing (height frozen for 12 s: three validators tolerate no fault, by design of 2f+1 quorums); `start-node 2` -> all three advance again from the same state root within 10 s (evidence/phase-f/validators-fault-probe.txt)
- Workspace with the new crate: `cargo test --workspace --release` exit 0 (26 suites ok, 0 failed), `cargo clippy --workspace --all-targets -- -D warnings` exit 0, `pnpm -r typecheck` exit 0, `forge test` 125 passed (evidence/phase-f/workspace-checks-consensus.log)
Tests: peal-links-consensus 6/0/0; every earlier suite unchanged and green against the validator stack (SDK 2/0/0, browser flow 1/0/0, edge 5/0/0)
Artifacts: evidence/phase-f/validators-*.log, validators-consensus-restart.txt, workspace-checks-consensus.log
Measured: idle chain about 2 blocks/s (23 in 10 s) after the 400 ms idle-proposal wait; an operation submitted to a validator is answered after finalization in about 0.3 to 1 s on this machine (from the test timings: the SDK e2e flow took 38 s against the validators versus 27 s single-node, the bridge flow 53 s versus 52 s)
What the gate proves: the ledger's ordering is decided by a Commonware simplex validator set, not by one process; every validator applies the same finalized blocks through the same ledger code, re-verifies every proof, and reports the same state root; a validator that starts late fetches what it missed by digest; mints are only ordered when the proposer and the voters each confirmed the deposit on their own chain view; withdrawal certificates need signatures from more than one process, each checking its own ledger.
Residual risks (recorded in MAINNET_READINESS.md): the three validators are processes on one machine under one operator (a working consensus path, not decentralisation); three validators tolerate no faulty member; the block backfill is a small custom protocol in place of `marshal`; validator keys are files under `.dev-state`; the product store (requests, inbox, intents, withdrawals) is per node; a validator whose RPC is down abstains, so with three validators consensus stalls until it returns.

### Adversarial review of the consensus path (Phase F feedback, 2026-09-16)
One reviewer (Opus tier) was asked to refute six claims about `crates/peal-links-consensus` and the node's validator mode with code-path counterexamples. Outcome, with what changed (commit `5d6484f`):
- Safety (identical ledgers after identical blocks): survived; the reviewer traced the only application path. Latent risk fixed: application used `apply_batch` with a per-validator RNG (safe only because the batch was always one), now `Ledger::apply` with the deterministic verifier.
- No trust substitution: survived for submissions (no `Ok` without a finalized application). Wording fixed in decision 0010: a mint is *voted for* only after this validator's own chain check; once a quorum finalizes it, every validator applies it without consulting the chain again.
- Robustness against a malicious peer: **refuted, fixed.** Any peer could fill every validator's block cache without bound (unsolicited blocks at arbitrary heights were cached forever), make the actor task verify proofs at the peer's pace (admission ran on the actor under the state lock), grow the mempool without a cap, and turn a proposal with an unknown parent into a permanent request broadcast. Now: unsolicited blocks are cached only within 256 heights ahead of the head or when asked for, the cache is capped at 4,096, admission runs off the actor with at most 64 in flight, the mempool is capped at 4,096 transactions / 32 MiB, and waits for blocks nobody supplies expire after 10 s. Test added: `a_flooding_peer_cannot_fill_caches_or_stall_the_chain`.
- Liveness: survived (no deadlock); two degradations fixed: application of a finalized block now runs off the actor task, and abstaining drops the vote sender instead of leaking it. A bookkeeping bug in the finalized-gap walk (`progressed` overwritten) fixed; `max_block_txs` clamped to the block format's cap at config load.
- Restart idempotency: survived (ledger writes commit before the head; re-application of a partial block is idempotent per transaction).
- Distributed settlement: **refuted, fixed.** Only peer signers recorded what they attested; the requester and the fixture signed with no per-position guard, so two certificates for one position with different recipients were possible (only the gateway's unique withdrawal id prevented a double release). Now every signer records `(namespace, position, epoch) -> digest` before signing and refuses a different digest. A signer rotation stranded certified withdrawals (the stored certificate's epoch was dead and nothing re-certified); `settle` now re-certifies under the new epoch. Certificates report their actual signers. Module doc corrected (no per-namespace cap or consumption check in `SignerPolicy`; both live in the gateway).
- A user-facing bug fixed: when only this validator's RPC lagged, the submitter was told the mint failed while a quorum credited it; the reply now waits for what the ledger does.
- Poisoned state lock no longer takes the validator down (`state::lock`).
Verification after the fixes: `cargo test -p peal-links-consensus` 4 integration + 3 unit passed; bridge suite on the validators 1 passed (53 s, evidence/phase-f/validators-fixed-bridge-vitest.log); browser flow + edge 6 passed (1.5 min, validators-fixed-browser-playwright.log); SDK e2e 1 passed (validators-fixed-sdk-e2e-vitest.log); `cargo test --workspace --release` 26 suites ok, clippy and typecheck clean, forge 125 passed (workspace-checks-review-fixes.log); all three validators agree after the runs.
Not fixed, recorded: the block backfill remains a custom protocol in place of `marshal`; `Status.state_root` after a crash between ledger and head writes reports the live ledgers' root until the next block; three validators tolerate no fault; the reviewer's byzantine-leader (equivocation) and divergent-oracle scenarios have no dedicated test beyond the engine's own guarantees.

## Phase G: one wallet, private by default (SPEC-ADDENDUM-one-wallet.md)

Started 2026-09-16 after Gate F. The addendum supersedes SPEC.md section 8 and parts of section 11; decisions 0011 (account-level authorization, local payment intents), 0012 (recovery by wallet capability), 0013 (directory and deposit linkage) record the reconciliations.

### What already-built code changes
- `crates/peal-bonsai/src/manifest.rs`: manifest version 2 carries `receiver_address`; the wasm `sign_request` takes it.
- `crates/peal-links-wasm`: sealed backups under a raw 32-byte key (`export_backup_with_key`, `import_backup_with_key`) next to the passphrase form.
- `packages/links` (SDK): `LinksAccount.create/open/restore(passphrase)` become `setup/unlock/recover` with a device key (non-extractable WebCrypto key in IndexedDB) and a recovery mechanism; `pay` takes a payment target (a request or a directory profile) and a verified local payment intent; `createRequest` signs with the account's key and names the wallet address; client gains directory, backup and profile calls; typed-data helpers for the profile, the intent and the recovery message.
- `crates/peal-links-node`: directory (append-only profiles, session-bound and rate-limited), backup store (versioned, anti-rollback), manifest v2 acceptance, request archival on revocation.
- `packages/explorer`: session module drives automatic setup and recovery on connect; the dashboard shows the connected 0x address only, two balances (Wallet, Private), a send form that accepts a 0x address or a link, Incoming versus Available with automatic claiming; the checkout becomes one continuous flow (Approve payment, Adding funds, Preparing payment, Payment sent) with fees shown before authorization; the landing page states that interface abstraction is not cryptographic unlinkability. Removed: passphrase forms, "Create private account", Lock/Unlock, the account id and encryption key display, the backup passphrase dialog.
- Tests: the flow and edge Playwright specs move to the one-wallet flow; the injected test wallet gains `eth_signTypedData_v4` and a contract-wallet stand-in.

### What is new
- Directory service and signed receiving profiles (decision 0013).
- Unified funding-plus-payment checkout with persisted progress.
- Recovery subsystem: derived-key path for deterministic EOAs, recovery-code path for the rest, node backup store, fresh-browser recovery (decision 0012).
- Invitation flow for unregistered addresses (no funds moved, no account created).
- Local payment intents (decision 0011).

### Revised gate criteria (addendum section 10; each evidenced per SPEC section 4)
- Gate C addendum: (3) receive and claim with no manual Bonsai identifier anywhere in the interface; (5) recover on a fresh browser through the wallet-signature path for an EOA and the recovery-code path for a wallet that cannot derive.
- Gate E addendum: (2) fund and complete a genuine Bonsai payment through the unified checkout; (6) resume an interrupted checkout without a duplicate payment; (8) pay an unregistered 0x address and get the honest invitation flow with no funds moved.
- Also demonstrated: (1) create and share a request, (4) return after being offline and see Incoming become Available, (7) withdraw to the authorized EVM destination.
- Two users, each interacting only through an existing EVM wallet, in one Playwright suite with the privacy assertions kept (no spending secrets, openings, balances or intent signatures on the wire).

### Blockers seen at planning
- Passkey PRF as a second factor is not built (the recovery code is the second factor; WebAuthn PRF support and its test harness are a separate piece of work).
- ERC-1271 verification is implemented against the namespace's RPC; no real contract wallet is deployed on the local chains, so the browser suite uses a test-provider stand-in that reports code at its address and signs non-deterministically, which exercises the recovery-code path but not a real ERC-1271 verifier. Recorded as such.
- Funded invitations are out of scope by the addendum.

### Phase G progress
- Built and pushed: manifest v2 (`receiver_address`); node directory (`PUT/GET /links/v1/directory`, EOA recovery and ERC-1271, append-only hash-chained log, per-session rate limit) and backup store (`PUT/GET /links/v1/backups/{ns}`, anti-rollback, last 8 versions); SDK `typed.ts` (EIP-712 profile, payment intent, recovery message, wallet signers), `device.ts` (non-extractable WebCrypto device key), `recovery.ts` (HKDF backup key, determinism check, recovery codes), `LinksAccount.setup/unlock/recover/restoreFile`, `resolve`, `pay` with a verified local approval, `createRequest` naming the wallet, automatic backups; explorer `session.ts` (`activate`, `recoverWithCode`, `payRequest`, `payAddress`, `rename`), dashboard, checkout and landing on the wallet-only flow; Playwright `wallet.ts` (typed data, non-deterministic signer stand-in, fresh funded wallets), `links-one-wallet.spec.ts`, `links-edge.spec.ts` rewritten; `links-flow.spec.ts` retired (superseded).
- Removed from the interface: passphrases, "Create private account", Lock/Unlock by passphrase, the account id and encryption key line, counterparty account ids in receipts and history, the backup passphrase dialog, the display-name field on link creation (the profile carries it).

### Gate C addendum (one wallet): criteria 3 and 5  [PASSED]
Commit: the commit that adds this record (on top of `b251582`).
Commands:
- `pnpm -C packages/explorer exec playwright test e2e/links-one-wallet.spec.ts` -> exit 0 (5 passed, 2.4 min; evidence/phase-g/one-wallet-playwright.log). Criterion 3: Bob activates from his wallet (one profile signature, one recovery signature), a payment reaches him and is claimed automatically; every page text is checked for 32-byte hex strings and the words "account id", "encryption key", "nullifier", "commitment" (`expectNoBonsaiIdentifiers`, evidence/phase-g/01-bob-activated.png, 08-bob-available.png). Criterion 5: Bob recovers on a fresh browser context through the wallet-signature path (07/08); Alice, whose test wallet signs non-deterministically, is given a recovery code at setup (03-alice-recovery-code.png) and recovers on a fresh browser with it after a wrong code is refused (10-alice-recovered-fresh-browser.png).
- `pnpm -C packages/links test` -> exit 0 (SDK: setup with one profile signature for two wallets, directory lookup and tamper refusal, session-bound lookups, an unregistered address resolves to null, a real deposit, a tampered manifest refused, a wrong wallet approval refused, a payment link paid with a verified local intent, a payment to a plain address, recovery on a fresh device through both mechanisms with a wrong code refused, unlock without a signature, a stale device reports a conflict; evidence/phase-g/sdk-e2e-vitest.log, sdk-bridge-vitest.log)
Tests: Playwright 5/0/0 (one wallet), 4/0/0 (edge); vitest 2/0/0
What the gate proves: two people with nothing but an EVM wallet set up, receive, claim and recover; the private account, keys, receipts and proofs never appear in the interface; recovery works through the mechanism the wallet supports.
Residual risks: the non-deterministic wallet is a test-provider stand-in (viem signing with fresh nonces), not a real contract wallet, so ERC-1271 verification in the node is implemented but not exercised end to end; passkey PRF is not built; the recovery code is shown once and, if lost together with the device, the account is unrecoverable (stated in the setup step).

### Gate E addendum (one wallet): criteria 2, 6 and 8  [PASSED]
Commit: as above.
Commands:
- Criterion 2 (evidence/phase-g/04-alice-checkout-needs-funds.png, 05-alice-adding-funds.png, 06-alice-payment-sent.png): the checkout shows the payee's chosen name and shortened wallet address, the route, and the estimated network fee for the funding leg before any authorization; "Approve and pay" asks the wallet for the local payment intent, adds exactly the shortfall rounded up to a whole unit through a real approve and deposit, waits for the ledger credit, claims it, proves and pays: "Approve payment", "Adding funds", "Preparing payment", "Payment sent".
- Criterion 6 (13-alice-after-reload.png): a reload during "Preparing payment" resumes without a second payment (the browser wallet reconnects silently, the account unlocks from the device key, the paid marker or the single pay button is shown; at most one envelope for the request reaches the payee).
- Criterion 8 (11-alice-invitation.png): sending to an address with no profile shows the invitation with a copyable invitation link and the balance is unchanged; sending to a registered address resolves and verifies the profile and pays (12-alice-sent-to-address.png).
- Also demonstrated: criterion 1 (02-bob-link-created.png), 4 (07-bob-incoming.png then 08-bob-available.png), 7 (09-bob-withdrawn.png: withdrawal to the connected wallet's address).
- Privacy: every request the browsers sent is checked for spending secrets, openings, balances, passphrases, recovery codes and the payment intent's fields; operation submissions carry exactly the envelope fields; inbox posts carry no amount (last test in the suite).
- `pnpm -C packages/explorer exec playwright test e2e/links-edge.spec.ts` -> exit 0 (4 passed: terminal states, a declining wallet and a wrong-network wallet, a concurrent payer held off, keyboard reachability; evidence/phase-g/edge-playwright.log)
- Workspace: `pnpm -r typecheck` clean, `pnpm -C packages/explorer build` 17 pages, `cargo test --workspace --release` 26 suites ok, clippy clean, forge 125 passed (evidence/phase-g/workspace-checks.log)
Residual risks: fees are an estimate (gas price times a fixed gas budget for approve plus deposit); the funding top-up rounds up to a whole unit; one-time requests remain a soft lock; the SDK bridge and one-wallet suites share anvil chains with the browser suites, which is why the browser suites use fresh wallets per run.

### Public testnet run: Ethereum Sepolia  [PASSED, 2026-09-16]
Deployment: `scripts/peal-links/testnet.sh deploy` from a deployer funded with 0.05 Sepolia ETH by the project owner (tx `0x1a934b55ea11a92288db0ad3780b31eff89bc02cf5ebe497ec46648949b63798`). Gateway `0xC141Bc6AaED24258276dC203050AD148ec95C1fC`, faucet test token `0x46A7b253abDcB7302e79FFed9Eb660D3B7a4967d` (tUSD, 6 decimals), deployed at block 11715473 on chain 11155111 through the public RPC `ethereum-sepolia-rpc.publicnode.com`; settlement fixture of three keys generated for the testnet (threshold 2), owner is the deployer. Deployment cost 0.0028 ETH.
Stack: `scripts/peal-links/testnet.sh up` runs a single-node Peal Links node on :8795 (`config/peal-links.sepolia.json`, confirmations 2, watcher every 6 s) and an explorer on :5174; the watcher verified chain id and gateway code and reported the namespace available (evidence/phase-g/sepolia/node-status.json).
Commands:
- `LINKS_URL=http://127.0.0.1:8795 EXPLORER_URL=http://localhost:5174 FUNDER_KEY=<testnet deployer> pnpm -C packages/explorer exec playwright test e2e/links-one-wallet.spec.ts` -> exit 0 (5 passed, 4.3 min; evidence/phase-g/sepolia/one-wallet-playwright.log, screenshots evidence/phase-g/sepolia/*.png). The suite funds fresh wallets from the testnet deployer (0.003 ETH each plus faucet tokens), so no shared key is reused.
On chain (gateway logs from the deployment block, read with `cast logs`): 2 `Deposit` events and 1 `Withdrawn` event(s); first withdrawal release tx `0x20b5a013be9d5207504eadf276518b06146d1f10d55f2d3fbebf22ef55e36abc` on https://sepolia.etherscan.io.
What it proves: the same code that ran on anvil runs against a public chain with 12 s blocks: real approve and deposit transactions from a browser wallet, credits after two confirmations, private payments proven in the browser, and a withdrawal certified by the committee and released by the gateway on Sepolia.
Residual risks: public RPC without an API key (rate limits are the node's and the tests' problem, not the chain's); single node, not the validator set; the testnet deployer owns the gateway; block-count confirmations rather than Ethereum finality tags; the explorer is local, so no public URL yet.

### Public testnet run: Tempo Moderato  [PASSED, 2026-09-16]
Deployment: `NETWORK=tempo scripts/peal-links/testnet.sh deploy` with the same deployer address; Tempo funds gas itself (`tempo_fundAddress`, PathUSD), so nothing was sent by anyone. Its estimator is an order of magnitude low and the chain rejects transactions above 30M gas, so the first attempt through the Foundry script ran out of gas at 6.6M; the script now uses `forge create` with an explicit 29M limit per transaction on this network. Gateway `0xE747A08e7cFea2574bCc9A0a8FCb6E02a68D6F39`, faucet test token `0x7065E9c7F6D2839Cff7d5d5c125C9c703C8A5e23`, from block 35525497 on chain 42431 (`https://rpc.moderato.tempo.xyz`, explorer https://explore.testnet.tempo.xyz). An earlier gateway at `0x46A7b253abDcB7302e79FFed9Eb660D3B7a4967d` on Tempo is unused (its token step did not run).
Code changes for the chain: `TX_GAS` (explicit gas on every write on chain 42431), `ensureGas` (the app funds a wallet's gas through the chain's faucet before a deposit or withdrawal), `gasSymbol` for the fee line, each namespace's `rpc_url` in the status document; `config/peal-links.tempo.json` with `confirmations: 10` (about 5 s at half-second blocks).
Commands:
- `NETWORK=tempo scripts/peal-links/testnet.sh up` -> node on :8796 (single-node, watcher every 3 s), explorer on :5175; the watcher verified chain id and gateway code and reported the namespace available (evidence/phase-g/tempo/node-status.json).
- `LINKS_URL=http://127.0.0.1:8796 EXPLORER_URL=http://localhost:5175 FUNDER_KEY=<deployer> pnpm -C packages/explorer exec playwright test e2e/links-one-wallet.spec.ts` -> exit 0 (5 passed, 2.0 min; evidence/phase-g/tempo/one-wallet-playwright.log, screenshots evidence/phase-g/tempo/*.png). Fresh wallets got gas from the chain's faucet and tokens from the test token's faucet.
On chain (gateway logs from the deployment block): 2 `Deposit` events and 1 `Withdrawn` event; withdrawal release tx `0x1573343d215ffc8172c326b8b14133c0aabaed69a8fe0a0211675cf0ecdd49e7`.
What it proves: the same node, contracts and browser flow run on two public chains with different block times, gas models and estimators (Sepolia 12 s blocks and ETH gas; Tempo half-second blocks and ERC-20 gas with a faucet), with no change to the ledger, the proofs or the trust model.
Residual risks: as for Sepolia; the 29M gas limit is a blanket value for the chain (unused gas is not charged there); the fee shown before authorization is an estimate.

### Testnet assets beyond the faucet token  [2026-09-16]
`NETWORK=<net> scripts/peal-links/testnet.sh allow <token> [cap]` puts an existing token on the gateway's allowlist (owner call) and enables the profile namespace that names it. Allowed and served: `sepolia/USDC` (Circle's testnet USDC `0x1c7d4b196cb0c7b01d743fbc6116a902379c7238`, 6 decimals, faucet at https://faucet.circle.com) and `tempo-moderato/PathUSD` (Tempo's own USD `0x20c0000000000000000000000000000000000000`, 6 decimals, the chain's gas token, handed out by `tempo_fundAddress`). Both nodes report all four namespaces available after restart. The app now offers test funds where it can (`testFundsSource` / `claimTestFunds`: the chain's faucet for PathUSD, the test token's `faucet` for tUSD, a link to Circle's faucet for USDC) on the dashboard's wallet balance and on the checkout's "Not enough funds" state. Caps: 1,000,000 units per withdrawal on the new assets. Not yet run through the browser suite on the new assets (the suite drives the first namespace); their on-chain legs use the same gateway code the tUSD runs exercised.

### Wallet chooser and one device with several wallets  [2026-09-16]
Found while the user tested with two MetaMask accounts: the local private state was keyed by namespace only, so the second wallet was told "this browser holds the private account of wallet …; clear site data". Now every wallet gets its own slice of the store (`walletScopedStore` in the SDK, keyed by the lowercased address); the explorer builds account options from the connected wallet's slice, locks the open account and re-reads "stored here" whenever the connected address changes, and adopts an account saved under the old bare keys on its owner's first use (`LinksAccount.adoptUnscoped`: `moved` for the owner, `other` for anyone else, so nothing is ever overwritten). Both connectors are always listed where a wallet is asked for (pay page and dashboard, `connectorChoices`: a browser wallet card, disabled with a hint when no extension is present, and a Privy card), and the checkout shows "paying from <connector> <address> · switch wallet". A wallet that refuses the chain switch at setup is told which chain it is on and which one the request needs, instead of the generic decline text.
Evidence: `pnpm -C packages/links exec vitest run -t "one device, two wallets"` (1 passed, live node); `pnpm -C packages/explorer test:e2e` 31 passed in 2.0 m (new: `two wallets in one browser each keep their own private account`; the wrong-network edge test asserts the new message; Carol in the one-wallet suite is a fresh address because the fixed anvil key had been activated on the persistent stack, which is what made that test fail); `docs/peal-links/evidence/phase-e/edge-second-wallet-same-browser.png` inspected: second wallet's dashboard, its own empty account, the connector line naming it. Residual: the Playwright wallet shim switches accounts by reload; a real wallet's `accountsChanged` event is not yet listened to, so a person who switches accounts in MetaMask without reloading keeps the old address until the next page load.

### Landing page rebuilt on the network landing's structure  [2026-09-16]
User feedback: the Peal Links landing put the checkout card in the opening section and did not follow the network landing (`pages/landing.tsx`). Rebuilt `pages/bonsai-landing.ts` on that page's structure and palette (cream, ink, the blue accent; eyebrow, display heading with an accented phrase, prose on the 780px measure, a scene drawn in depth between the paragraphs, a try row, a fine-print note, a centred close). The hero is a rounded card with one headline, one call to action and a floating link in front of the sealed facts; the checkout moved into "What Peal Links does" as a scene that steps through request, proving and accepted with what the public ledger and the receiver see standing behind it (auto-runs once on view, click to step, reduced motion shows the final state). Other scenes reuse the landing's own stage and card styles: the public-chain queue (the problem), the three-panel handshake (three steps), the wallet in front of its private account and backup (one wallet). Copy re-checked against the code: the FAQ's device-loss answer now describes recovery by wallet signature or recovery code (it still described the old backup-file-only model), a "more than one wallet" answer was added, the developer section shows the real SDK sequence (`LinksAccount.setup`, `createRequest`, `pay` with a signed intent, `syncInbox`, `claimAll`) instead of the Rust crate with a "bindings are being built" note, and the observer matrix is unchanged from THREAT_MODEL.md. The page sets `body.pl-landing-page` (cream background, unclamped main) and clears it on leave; the shell header stays. Landing styles are `.pl-ld-*` in `links.css`; nothing in the app or checkout changed.
Evidence: `SHOTS_DIR=docs/peal-links/evidence/phase-g pnpm -C packages/explorer exec playwright test e2e/screenshots.spec.ts -g "landing at"` 3 passed (no horizontal overflow, no page errors at 390, 820 and 1280); `docs/peal-links/evidence/phase-g/landing-{phone,tablet,desktop}.png` inspected, plus per-section captures during the work (problem-scene caption collision, observer cards hidden behind the checkout, wallet cards floating above their caption, a clipped ghost card on the phone hero and a mis-anchored illustration tag on the phone were all found in the captures and fixed). Residual: the dashboard and the checkout page keep their earlier look and are the next UI pass.

### Landing page, second pass: the mempool landing's shape  [2026-09-16]
User feedback on the rebuild: keep the scenes and the content, but the page should look like `#/mempool`, with the checkout scene in the opening section. Done: the page now uses the mempool landing's own classes (`.ml-hero`, `.ml-h1`, `.ml-sub`, `.ml-btn`/`.ml-btn-dark`, `.ml-section`, `.ml-sec-kicker`, `.ml-story-h2`, `.ml-p`, `.ml-foot`) over the explorer's sky background, lowercase display copy, centred section heads and prose; the checkout with its two observers sits directly under the hero's buttons and runs through request, proving and accepted once when the page opens. The network landing's stage and card mechanics are kept for the scenes and recoloured to the explorer's tokens (`.pl-ld` overrides in `links.css`); the three-step handshake moved into "what Peal Links does" and the separate steps section went away. No body class is set any more; the shell header and main are as on every product page.
Evidence: `SHOTS_DIR=docs/peal-links/evidence/phase-g pnpm -C packages/explorer exec playwright test e2e/screenshots.spec.ts -g "landing at"` 3 passed (no overflow, no page errors at 390, 820, 1280); `docs/peal-links/evidence/phase-g/landing-{phone,tablet,desktop}.png` inspected, plus per-section captures at desktop and phone.

### Dashboard rebuilt as a full-screen product shell  [2026-09-16]
User feedback: the app should be simple, crystal clear, light, a "complete full scale dashboard" in the style of a SaaS product (sidebar, page head, white cards, forms as pages). Rebuilt `pages/bonsai-app.ts` and added the `.pla-*` styles in `links.css`. The route now takes the whole window (site header hidden, main unclamped, `body.pla-page`), with a sticky sidebar (brand, network selector, Overview / Payment links / Incoming / Activity / Settings, the wallet card with the connector, address, "private payments on", Lock and Disconnect, and a link back to Peal Network) and a main column with a page head and cards. Overview: three balance cards, four quick actions, recent incoming and activity, the ledger line. Money actions open as pages with a form (new payment link with expiry as radio cards; send; add funds and withdraw with their three steps spelled out; test funds; display name; import backup) and a Cancel / primary button row; the link-created page shows the QR and the URL. Settings gathers profile, recovery and backups, this device (auto-claim switch, Lock, Disconnect) and the network facts. Dialogs are gone; the page never repaints under a form that has been touched (`form[data-dirty]`), and a view change slides in once. Every flow and identifier the browser suites rely on is kept (`#pl-request-form`, `#pl-send-form`, `#pl-fund-form`, `#pl-withdraw-form`, `#pl-recovery-code`, `#pl-link-url`, `#pl-invite`, `.pl-balance` / `.pl-balance-amount`, button names); the suites' list selector moved from `.pl-list` to `.pla-list`.
Evidence: `pnpm -C packages/explorer test:e2e` 31 passed (edge, one-wallet, screenshots); `docs/peal-links/evidence/phase-g/app-{desk,phone}-*.png` inspected (connect, continue, overview, new link, link created, links list, add funds, settings, at 1280 and 390; the phone shell overflow and the sidebar wallet line were found in the captures and fixed).

### Dashboard, second pass: Peal Private Links, full product shell, Sepolia by default  [2026-09-16]
User feedback: rename to "Peal Private Links", a way back from every page, Ethereum Sepolia as the default and live network, and a deeper redesign of every section in the manner of a modern payments product (top bar with breadcrumb, a large balance with dark action pills, lists grouped by day, a details panel with a timeline, search and filters). Done:
- **Sepolia is the default.** The Sepolia explorer now serves on :5173 (`TESTNET_EXPLORER_PORT` default) with `sepolia/USDC` (Circle's testnet USDC) as the first namespace and `sepolia/tUSD` second; the local anvil stack's explorer moved to :5176 (`EXPLORER_PORT` default, Playwright `baseURL` default, `config/peal-links.local.json` auth domains). Both restarted; the Sepolia node reports both namespaces available.
- **Routes inside the app.** Sections and pages live in the fragment (`#/bonsai/app/links`, `/incoming`, `/activity`, `/settings`, `/new-link`, `/send`, `/fund`, `/withdraw`, …). `main.ts` no longer tears the app down when the hash moves between two of its own routes (`APP_ROUTE`); the app listens to `hashchange` itself. The browser's back button works, the page head has a back control that goes back through history when the app navigated (else to the parent section), and the top bar shows the breadcrumb.
- **Shell.** Sidebar (brand "Peal Private Links", sections with icons, the wallet card, a link to Peal Network); top bar (breadcrumb, network chip with a live dot and the selector, help, wallet chip with avatar, name and connector); grey canvas with white cards.
- **Overview.** A balance block: the private balance large, "as of now · only you can see it", dark pills Send to an address / New payment link, light pills Add funds / Withdraw, a "…" menu (test funds, CSV export, backup export, display name, refresh), incoming and wallet mini-stats. Recent activity and payment links side by side.
- **Payment links.** Stats (links, paid, how it is paid), search by title or reference, filters (all / awaiting / paid / expired / archived), rows grouped by day. A row opens the details drawer: amount, the URL with Copy and Visit link, status, created, expires, reference, paid on, receiving wallet, a timeline (created → awaiting → paid / expired / archived), Cancel request, Request this again (prefills a new link).
- **Incoming and Activity.** Stats, rows grouped by day, drawers with the amount, the facts and a timeline (incoming: reached you → verified → claim, with Claim now); an activity entry shows what, when, to, the link, the ledger position, and for a withdrawal the recipient, settlement status and the transaction with an explorer link.
- **Forms** (new link, send, add funds, withdraw, test funds, display name, import backup) keep the page-with-a-form shape with the three steps spelled out; **Settings** as before with the network facts and gateway explorer links.
- **Motion.** View change slides in once; the drawer slides from the right (from the bottom on a phone) behind a scrim; the menu pops; rows and pills lift on hover; Escape closes.
Every flow and identifier the browser suites rely on is kept; the "Withdraw" and "Add funds" actions are now links styled as pills, which Playwright's role queries still find by name.
Evidence: `pnpm -C packages/explorer test:e2e` (against :5176) 31 passed, exit 0, after two regressions the suite caught in the first run of this pass were fixed (the action pills had become links, so "New payment link", "Add funds" and "Withdraw" were no longer buttons for role queries and keyboard users; and the balance test hooks matched the whole balance block, so the incoming figure read the private balance). Commit `e1f9ab2` recorded the pass before these fixes; this commit is the one the evidence belongs to; `docs/peal-links/evidence/phase-g/v2app-{desk,phone}-*.png` inspected (connect, overview, more menu, new link, link created, links list with the drawer open, send, withdraw, activity, settings; no horizontal overflow at 1280 or 390; `page.goBack()` from settings returns to activity).

### Browser wallet only  [2026-09-17]
User decision: Peal Private Links offers the browser wallet only. `connectorChoices` shows one card ("Connect browser wallet"; when no extension is present, "No browser wallet found" with a link to MetaMask), the checkout copy no longer mentions Privy, and the keyboard edge test expects the single button. Privy stays wired in `auth.tsx` and the session module for the rest of the site and for wallets that were connected through it before; nothing in the Peal Private Links pages offers it any more. Edge suite 5 passed.

### Checkout rebuilt in the app's design language  [2026-09-17]
`pages/pay.ts` renders one centred card on the app canvas (`.pc-*` styles; buttons, inputs, rows and the timeline are the app's): the title and amount with the status chip beside them, the payee with a generated identicon, name first and "0x… · verified on this device" on one line, then only the rows that matter (asset, fees when a funding leg is needed, reference, expiry, paying from), then one dark button with a single line of help. The progress list during a payment is the app timeline with a spinner on the current step (the `.pl-steps` / `.pl-step-active` hooks the suites use stay on it); "Payment sent" is a green confirmation block. A tampered request shows a red notice in the head instead of a row. Found and fixed on the way: the dark button's colour token lives on the app root class, which the checkout root did not carry, so the primary button was transparent until hovered. Three suites 31 passed; `docs/peal-links/evidence/phase-g/v7-*.png`, `v8-*.png` inspected (connect, continue, pay, proving, sent; phone).

### Next step
Hosting for public testers (a reachable node and explorer with HTTPS), then Base Sepolia and Arbitrum Sepolia namespaces. Mainnet stays blocked as recorded in MAINNET_READINESS.md.
## Handoff
What works: Peal Links end to end on a local two-chain stack, with the connected EVM wallet as the only visible identity (SPEC-ADDENDUM-one-wallet.md): first use is one sign-in, one account authorization and one recovery message; later visits unlock from a device key; a fresh browser recovers through the wallet signature or a recovery code; a plain 0x address can be paid through the directory, and an address that never activated gets an invitation with no funds moved. A receiver creates a payment link on the dashboard; a payer opens it, funds a private account from a connected wallet through a real ERC-20 deposit into `PealLinksGateway` on anvil chain A (credited by the node's watcher after two confirmations, proven by the R_dep circuit), pays with a ZK-Pari R_op proof made in a Web Worker, and the receipt reaches the receiver encrypted through the inbox; the receiver claims it with a second proof, acknowledges the request, and withdraws with a burn proof plus a disclosure that the signer fixture certifies (EIP-712, threshold 2 of 3) so chain A's gateway releases the tokens. Replays are refused by the ledger and by both gateways. Backups are encrypted with argon2id and restore on a fresh browser. The ledger replays from its sqlite log with every proof re-verified.
Run it: `scripts/peal-links/demo.sh` (everything, about 3 min after the first build); or `scripts/peal-links/stack.sh up` then open http://localhost:5173/#/bonsai; validator mode: `PEAL_LINKS_VALIDATORS=3 scripts/peal-links/stack.sh reset` and `scripts/peal-links/stack.sh consensus`. Browser suites: `pnpm -C packages/explorer exec playwright test e2e/links-one-wallet.spec.ts e2e/links-edge.spec.ts` (do not edit files under `packages/` while they run). Tests: `cargo test --workspace --release`, `forge test`, `pnpm -C packages/links test`, `pnpm -C packages/explorer test:e2e`. Smoke: `cargo test -p peal-bonsai --release`.
Routes: explorer `http://localhost:5173/#/bonsai` (landing), `#/bonsai/app` (dashboard), `#/pay/<id>` (checkout); node `http://127.0.0.1:8790/links/v1/status`, `/links/v1/params`, `/links/v1/ledger/{namespace}`, `/links/v1/requests`, `/links/v1/inbox/...`, `/links/v1/deposits/intents`, `/links/v1/withdrawals` (full list in ARCHITECTURE.md and OPERATIONS.md); anvil chain A `http://127.0.0.1:8545` (id 31337), chain B `http://127.0.0.1:8546` (id 31338).
Tested chains and modes: two local anvil chains only (31337 and 31338), TestUSD (6 decimals) with a public faucet; single ledger node with the single-process signer fixture (default), and three local simplex validators with one settlement key each (`PEAL_LINKS_VALIDATORS=3`), both with anvil keys 5, 6, 7 at threshold 2; real deposit path (dev mint default-off). No public testnet run. No mainnet. Injected EIP-1193 wallets and Privy embedded wallets are both supported in the app; the tests use an injected provider backed by viem.
Upstream revisions: zk-pari `a8266aac58314214552a214fead1c0258f8de418` (PR #2 head, pinned by revision in `Cargo.toml`); Commonware crates `commonware-consensus`, `-p2p`, `-runtime`, `-cryptography`, `-utils`, `-codec`, `-actor`, `-parallel` pinned `=2026.9.0` (monorepo tag `v2026.9.0`, `d476a2361ce6840d2b9d0aa6fb30a924429046d4`; API map in research/commonware-simplex-api.md); simple-bte `147a0878` (existing Peal dependency); OpenZeppelin 5.1 for the gateway.
Measured results: BENCHMARKS.md. R_op prove 521 ms native (10 threads) and 6.4 to 6.7 s in wasm (single thread); verify 0.94 ms; batch of 32 at 0.79 ms per operation including sqlite writes; proving key load 0.7 s in the browser; full flow 48 to 56 s in the browser with five proofs and six chain transactions at one block per second.
Screenshots: evidence/phase-g/01..13-*.png (the one-wallet flow: activation, link, recovery code, unified checkout, incoming to available, withdrawal, recovery on a fresh browser, invitation, send to an address, reload), evidence/phase-e/edge-*.png (edge states), evidence/phase-b/*.png (routes at three widths).
Known limitations: the node's directory knows which wallet owns which private account (stated on the landing page and in THREAT_MODEL.md); passkey PRF is not built; ERC-1271 is implemented but not exercised with a real contract wallet; consensus is a local three-validator stack on one machine (single-node remains the default); committee-attested bridge; one-time requests are a ten-minute soft lock rather than ledger admission; confirmation policy is a block count; the inbox is public-write; no rate limits; no public testnet run; Docker manifests unexercised; the proving keys come from a per-process setup with the trapdoor discarded, not a ceremony.
Blocking real-money activation: (1) a multi-party trusted setup for R_op and R_dep at the pinned circuit id with published transcripts; (2) a proof of simulation extractability for ZK-Pari, or a written risk acceptance (paper Remark 2); (3) external review of zk-pari PR #2, the circuits' integration, the ledger STF, the gateway and the node API; (4) Poseidon parameter security checks from the reference implementation; (5) independent settlement signers with HSM custody and a gateway owner behind a timelock and multisig; (6) chain-specific finality policies and verified deployments on Ethereum, Base and Arbitrum; (7) a public testnet run recorded here. Full table in MAINNET_READINESS.md.
Trust model of the demo: proofs are real (ZK-Pari over BLS12-381, verified by the node on every operation and again on replay); the ledger is either one operator's process or three validator processes on the same machine agreeing through simplex (ordering by consensus, still one operator); deposits are credited by that operator's watcher from chain events; withdrawals are released by the gateway on a 2-of-3 certificate from three signer keys held by the same process, so funds inside the ledger are custodied by the operator and the committee together. Privacy is against the operator (amounts, senders and receivers are hidden by the proofs and the encrypted inbox), custody is not. Stated in the app, THREAT_MODEL.md and MAINNET_READINESS.md.

### Next step
None required for the local build. Open items are in MAINNET_READINESS.md; the largest remaining engineering items are validators on separate machines with independent operators, `marshal` adoption for durable ordered delivery, and a public testnet run.
