# Peal Links build status

Living log. Read this first every session. Spec: `SPEC.md`.

## Current phase: D (funding and withdrawals)

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
| D | OPEN | | |
| E | OPEN | | |
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

### Blocker: multi-node consensus
Blocked: decentralised ordering of ledger operations.
Reason: the Commonware `simplex` integration (2026.9.0) was reordered after the end-to-end product flow so that every later phase could be verified against a real ledger first; it has not been started.
Done instead: a single-node ledger actor with deterministic ordering, batched verification and a replayable, hash-chained state root, labelled `single-node` in the status document and the app.
Isolation: `ledger_mode` is reported as `single-node`; no code claims otherwise.
Unblock requirement: implement the `Automaton`/`Relay`/`Reporter` application over `commonware_consensus::simplex` with the ledger STF as the block executor, run three or more local validators under `stack.sh`, and re-run Gates C to E against it.

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

### Next step
Write `crates/peal-links-node/src/evm.rs`, `watcher.rs`, `settlement.rs`; deploy contracts from `stack.sh`.
