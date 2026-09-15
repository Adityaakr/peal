# Peal Links build status

Living log. Read this first every session. Spec: `SPEC.md`.

## Current phase: A (discover and prove the foundation)

### Smoke command
```
cargo test -p peal-bonsai --release
```
(until the crate exists, the upstream smoke is: clone zk-pari at `a8266aac58314214552a214fead1c0258f8de418`, `cargo test --release --features circuits`; expected 31 passed, 1 ignored)

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
| A | OPEN | | |
| B | OPEN | | |
| C | OPEN | | |
| D | OPEN | | |
| E | OPEN | | |
| F | OPEN | | |

### Blockers
(none recorded yet)

### Decisions
(see `decisions/`)

### Next step
Write `crates/peal-bonsai` (params, wallet, ledger STF over rusqlite) and its Gate A tests.
