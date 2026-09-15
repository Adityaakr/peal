<!-- Peal Links block. Keep it short; the detail lives in docs/peal-links/SPEC.md. -->

# Peal Links (Bonsai private payments) build

## What is happening
Peal Links, a Bonsai-powered private payments section, is being built inside this repo by Claude Code across many sessions. Full spec: `docs/peal-links/SPEC.md`. Living log: `docs/peal-links/BUILD_STATUS.md`.

## Every session
1. Read `docs/peal-links/BUILD_STATUS.md` first, then the SPEC section for the current phase.
2. Run the smoke command recorded in BUILD_STATUS.md. Continue from "Next step". Do not re-plan from scratch.
3. Update BUILD_STATUS.md at every gate, decision, and blocker, and before any long command. Commit at every gate.
4. If context runs low: write the exact next step, commit, stop cleanly.

## Non-negotiables
- Brand is Peal. Product is Peal Links. Foundation is Commonware Bonsai with ZK-Pari. No substitutes, no RISC Zero Bonsai.
- Never fake: no mock proof, mock verifier, demo-flag success, stubbed deposit, or hidden trust substitution in the default path. Blocked capabilities are isolated, default-off, and recorded as blockers (format in SPEC section 4).
- Never weaken cryptography, skip signature validation, disable or loosen a test, or trust a server to pass a demo.
- No real funds, no production transactions, no live contract replacement, nothing published over the live site.
- No secrets in git, URLs, logs, analytics, or crash reports. Never invent secrets, addresses, capabilities, or results.
- Do not break existing Peal routes or functionality.
- No routine clarification questions. Decide, record in `docs/peal-links/decisions/`, continue.

## Engineering rules
- Money is integer base units everywhere; integer strings on JSON boundaries. Never floats.
- Bind every signature, operation, receipt, and certificate to its domain: chain, namespace, epoch, application.
- Validate canonical encodings, field bounds, point validity, and subgroup membership before expensive work.
- Persist intent IDs before irreversible operations. Idempotency keys bind request contents.
- Prefer existing frameworks, package manager, database, components, and tests. New dependencies only for concrete needs.
- Rust for Bonsai, Commonware, and ledger work. Typed TypeScript SDK at the application boundary.

## Git
- Branch `feat/peal-links`. Commit at gates and checkpoints. Never force-push, rewrite shared history, or merge to the default branch.

## Evidence
- A gate is closed only by a record in BUILD_STATUS.md: commit, commands, exit codes, test counts, artifact paths, residual risks. Screenshots are inspected, then the problems are fixed.

## Commands
Repository tooling: Rust workspace (`Cargo.toml`, crates in `crates/`), pnpm 11 monorepo (`pnpm-workspace.yaml`, packages in `packages/`), Foundry contracts in `contracts/`, task runner `just` (`justfile`). Foundry lives at `~/.foundry/bin` (add to PATH). Docker is not installed on the build machine; the local stack runs under `scripts/peal-links/stack.sh` instead of compose.
- Install: `just setup` (rustup wasm target, submodules, cargo fetch, pnpm install). Foundry: `export PATH="$HOME/.foundry/bin:$PATH"`.
- Dev server: `pnpm -C packages/explorer dev` (vite, proxies `/v0`, `/v1` to the coordinator and `/links` to the Peal Links node).
- Test (unit / integration / e2e): `cargo test --workspace` (Rust); `pnpm -r test` (TS, vitest); `cd contracts && forge test` (Solidity); `pnpm -C packages/explorer test:e2e` (Playwright, needs the local stack up).
- Lint and typecheck: `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings`; `pnpm -r typecheck`; `pnpm -C packages/explorer build` (tsc + vite).
- Local stack up / down / reset: `scripts/peal-links/stack.sh up|down|reset` (two anvil chains, gateway deploys, ledger node, explorer).
- Full demo flow: `scripts/peal-links/demo.sh` (brings the stack up and drives request, deposit, pay, claim, withdraw with test funds).
- Smoke check: `cargo test -p peal-bonsai --release` (pinned zk-pari send and receive on the persistent ledger).
