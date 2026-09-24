#!/usr/bin/env bash
# The BTE v1 committee as separate processes on one machine, without Docker:
# a coordinator, five operator nodes with their own identities, a DKG round
# through the coordinator's relay, then a seal-to-reveal end to end.
#
#   scripts/bte/v1-stack.sh up       build, start, run the DKG, leave running
#   scripts/bte/v1-stack.sh e2e      seal three payloads and wait for the reveal
#   scripts/bte/v1-stack.sh down     stop everything
#   scripts/bte/v1-stack.sh reset    down, wipe state, up
#   scripts/bte/v1-stack.sh demo     reset, e2e, down (what CI would run)
#
# State lives under .dev-state/bte-v1 (gitignored): the coordinator's sqlite
# database, one directory per operator with its encrypted identity and
# committee share, logs and pids. The keystore passphrase is the devnet one;
# nothing here is a real deployment.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="$ROOT/.dev-state/bte-v1"
LOGS="$STATE/logs"
PIDS="$STATE/pids"
PORT="${BTE_V1_PORT:-8091}"
COORD="http://127.0.0.1:$PORT"
N="${BTE_V1_OPERATORS:-5}"
export BTE_KEYSTORE_PASS="${BTE_KEYSTORE_PASS:-devnet-pass}"
BIN="$ROOT/target/release"

build() {
  (cd "$ROOT" && cargo build --release -p bte-coordinator -p bte-node -p bte-cli)
}

start() {
  local name="$1"; shift
  mkdir -p "$LOGS" "$PIDS"
  "$@" >"$LOGS/$name.log" 2>&1 &
  echo $! >"$PIDS/$name.pid"
}

stop_all() {
  if [ -d "$PIDS" ]; then
    for f in "$PIDS"/*.pid; do
      [ -e "$f" ] || continue
      pid="$(cat "$f")"
      kill "$pid" 2>/dev/null || true
      rm -f "$f"
    done
  fi
}

wait_http() {
  local url="$1" tries="${2:-60}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "timed out waiting for $url" >&2
  return 1
}

up() {
  build
  mkdir -p "$STATE" "$LOGS" "$PIDS"
  echo "coordinator on $COORD"
  BTE_DEV=1 DATABASE_URL="sqlite://$STATE/bte.db" BTE_LISTEN="127.0.0.1:$PORT" \
    start coordinator "$BIN/bte-coordinator"
  wait_http "$COORD/v0/healthz"

  local operators=()
  for i in $(seq 1 "$N"); do
    local dir="$STATE/op-$i"
    mkdir -p "$dir"
    if [ ! -f "$dir/identity.json" ]; then
      "$BIN/bte-cli" identity-new --out "$dir/identity.json" >"$LOGS/identity-$i.log"
    fi
    operators+=("$("$BIN/bte-cli" identity-show --file "$dir/identity.json" | awk '/^operator:/ {print $2}')")
    BTE_DEV=1 start "node-$i" "$BIN/bte-node" --coordinator "$COORD" \
      --identity "$dir/identity.json" --state-dir "$dir" --poll-ms 500
  done

  # One round per fresh state directory. If the operators already hold a
  # committee (a restart), the coordinator lists it and nothing is started.
  if ! curl -fsS "$COORD/v0/committees" | grep -q '"scheme":"v1"'; then
    local args=()
    for op in "${operators[@]}"; do args+=(--operator "$op"); done
    "$BIN/bte-cli" dkg-init --coordinator "$COORD" --tag "local-v1" \
      --ack-timeout-secs 20 --wait-secs 120 "${args[@]}"
  fi
  curl -fsS "$COORD/v0/committees/default" | head -c 400; echo
}

e2e() {
  "$BIN/bte-cli" e2e --coordinator "$COORD" --in-secs 3 --timeout-secs 120 \
    --expect-verified-at-least "$(( N - (N - 1) / 3 ))"
}

case "${1:-}" in
  up) up ;;
  e2e) e2e ;;
  down) stop_all ;;
  reset) stop_all; rm -rf "$STATE"; up ;;
  demo) stop_all; rm -rf "$STATE"; up; e2e; stop_all ;;
  *) echo "usage: $0 up|e2e|down|reset|demo" >&2; exit 2 ;;
esac
