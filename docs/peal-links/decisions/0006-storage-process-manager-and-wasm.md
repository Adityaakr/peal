# 0006: sqlite ledger store, a process-manager script instead of Docker, single-threaded wasm prover

Date: 2026-09-16. Status: accepted.

## Decision
- **Ledger and product storage: sqlite via `rusqlite`**, which is what the existing coordinator uses. Ledger state (`ledger.sqlite`) is a separate file from product metadata (`links.sqlite`). PostgreSQL is not introduced.
- **Local stack: `scripts/peal-links/stack.sh`** (two anvil chains, contract deploys, ledger node, explorer) with pids and logs under `.dev-state/peal-links/`. Docker is not installed on the build machine, so compose files are prepared but cannot be exercised here; the script is the tested path.
- **Browser prover: single-threaded wasm** (`zkpari` with `default-features = false`, no `parallel`). The explorer is served by Caddy and Vite without `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`, so `SharedArrayBuffer` and wasm threads are unavailable. Proving runs in a Web Worker so the UI stays responsive.

## Why
- The repo already ships sqlite, WAL and a schema-in-code pattern; a new database engine would be a dependency with no concrete need.
- `docker` is absent and installing a system daemon is outside the run's remit; the spec allows the repository's process manager.
- Setting COOP/COEP on the public site would break the cross-origin `peal.js` embed story and third-party fonts; a single-threaded build is the honest default, with the measured cost recorded in BENCHMARKS.md.

## Consequences
- Multi-node consensus (Phase C) runs as separate processes under the same script.
- Browser proof time is several times the native number; measured, not estimated, in BENCHMARKS.md.
