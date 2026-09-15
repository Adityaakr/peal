# Peal Links build status

Living log. Read this first every session. Spec: `SPEC.md`.

## Current phase: B (design and navigation)

### Smoke command
```
cargo test -p peal-bonsai --release
```
Expected: 7 passed, 0 failed (encoding 2, gate_a 3, parity 2), about 12 s including keygen.

### Environment (build machine, 2026-09-16)
- Apple M5, 10 cores, 24 GiB. macOS 25.4. Rust 1.97.0, Node 22.23.2, pnpm 11.9.0, wasm-pack present, wasm32-unknown-unknown target installed.
- Foundry 1.6.0 at `~/.foundry/bin` (not on PATH by default). `just` installed via brew.
- Docker is NOT installed. Compose files are prepared but the local stack runs under `scripts/peal-links/stack.sh` (process manager script, logs and pids under `.dev-state/peal-links/`).
- Playwright not yet installed (added in Phase E).

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
| B | OPEN | | |
| C | OPEN | | |
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

### Next step
Install Playwright in `packages/explorer` (`@playwright/test`, chromium), then write `packages/explorer/src/pages/bonsai-landing.ts`.
