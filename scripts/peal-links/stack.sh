#!/usr/bin/env bash
# Peal Links local stack, without Docker.
#
#   scripts/peal-links/stack.sh up      start anvil A and B, the node, the explorer
#   scripts/peal-links/stack.sh down    stop everything started here
#   scripts/peal-links/stack.sh reset   stop, wipe ledger and product state, start
#   scripts/peal-links/stack.sh status  what is running and where
#   scripts/peal-links/stack.sh logs    tail every log
#
# State: .dev-state/peal-links/{pids,logs,data}. Proving keys: .dev-params
# (generated on first start, a few seconds; never committed).
#
# Every process is real: the node verifies real proofs against its sqlite
# ledgers; anvil is a real EVM. The only development-only path is the
# labelled mint endpoint enabled with PEAL_LINKS_DEV_MINT=1, which credits a
# registered deposit intent without a chain event (Phase C fixture; the
# watcher replaces it in Phase D).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="$ROOT/.dev-state/peal-links"
PIDS="$STATE/pids"
LOGS="$STATE/logs"
DATA="$STATE/data"
CONFIG="${PEAL_LINKS_CONFIG:-$ROOT/config/peal-links.local.json}"
export PATH="$HOME/.foundry/bin:$PATH"

ANVIL_A_PORT="${ANVIL_A_PORT:-8545}"
ANVIL_B_PORT="${ANVIL_B_PORT:-8546}"
NODE_PORT="${NODE_PORT:-8790}"
EXPLORER_PORT="${EXPLORER_PORT:-5173}"
# One anvil mnemonic for both chains, so the same test keys are funded on
# each. This is the public anvil default and never carries real funds.
ANVIL_MNEMONIC="test test test test test test test test test test test junk"

mkdir -p "$PIDS" "$LOGS" "$DATA"

running() { [ -f "$PIDS/$1.pid" ] && kill -0 "$(cat "$PIDS/$1.pid")" 2>/dev/null; }

start() {
  local name="$1"; shift
  if running "$name"; then echo "$name already running (pid $(cat "$PIDS/$name.pid"))"; return; fi
  # Two statements, not `cd && cmd &`: that would background a subshell and
  # record its pid instead of the process's, so `down` would orphan it.
  (
    cd "$ROOT"
    nohup "$@" > "$LOGS/$name.log" 2>&1 &
    echo $! > "$PIDS/$name.pid"
  )
  echo "$name started (pid $(cat "$PIDS/$name.pid")) -> $LOGS/$name.log"
}

stop() {
  local name="$1"
  if running "$name"; then
    kill "$(cat "$PIDS/$name.pid")" 2>/dev/null || true
    for _ in $(seq 1 30); do running "$name" || break; sleep 0.2; done
    running "$name" && kill -9 "$(cat "$PIDS/$name.pid")" 2>/dev/null || true
    echo "$name stopped"
  fi
  rm -f "$PIDS/$name.pid"
}

wait_http() {
  local url="$1" name="$2"
  for _ in $(seq 1 120); do
    if curl -fsS "$url" >/dev/null 2>&1; then echo "$name ready at $url"; return 0; fi
    sleep 0.5
  done
  echo "$name did not come up at $url; see $LOGS/$name.log" >&2
  return 1
}

cmd_up() {
  if command -v anvil >/dev/null 2>&1; then
    start anvil-a anvil --port "$ANVIL_A_PORT" --chain-id 31337 --block-time 1 --mnemonic "$ANVIL_MNEMONIC" --silent
    start anvil-b anvil --port "$ANVIL_B_PORT" --chain-id 31338 --block-time 1 --mnemonic "$ANVIL_MNEMONIC" --silent
  else
    echo "anvil not found (install Foundry); EVM chains not started" >&2
  fi
  ( cd "$ROOT" && cargo build --release -p peal-links-node 2>&1 | tail -1 )
  start node env PEAL_LINKS_LISTEN="127.0.0.1:$NODE_PORT" "$ROOT/target/release/peal-links-node" --config "$CONFIG"
  wait_http "http://127.0.0.1:$NODE_PORT/healthz" node
  start explorer pnpm -C packages/explorer dev --port "$EXPLORER_PORT" --strictPort
  wait_http "http://localhost:$EXPLORER_PORT/" explorer
  echo
  echo "explorer  http://localhost:$EXPLORER_PORT/#/bonsai"
  echo "node      http://127.0.0.1:$NODE_PORT/links/v1/status"
  echo "anvil A   http://127.0.0.1:$ANVIL_A_PORT (chain 31337)   anvil B http://127.0.0.1:$ANVIL_B_PORT (chain 31338)"
}

cmd_down() {
  for name in explorer node anvil-b anvil-a; do stop "$name"; done
}

cmd_reset() {
  cmd_down
  rm -rf "$DATA"
  mkdir -p "$DATA"
  echo "ledger and product state wiped ($DATA)"
  cmd_up
}

cmd_status() {
  for name in anvil-a anvil-b node explorer; do
    if running "$name"; then echo "$name: running (pid $(cat "$PIDS/$name.pid"))"; else echo "$name: stopped"; fi
  done
  curl -fsS "http://127.0.0.1:$NODE_PORT/links/v1/status" 2>/dev/null | head -c 400 && echo || true
}

cmd_logs() { tail -n 40 "$LOGS"/*.log; }

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  reset) cmd_reset ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  *) echo "usage: $0 up|down|reset|status|logs" >&2; exit 2 ;;
esac
