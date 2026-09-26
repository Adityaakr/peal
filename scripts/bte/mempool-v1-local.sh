#!/usr/bin/env bash
# The encrypted mempool on a BTE v1 (DKG) committee, locally, no browser:
# anvil, the two-lane contracts, the relayer and the settler, the v1 committee
# stack (coordinator + five node processes + a DKG round), then a driver that
# does what the explorer's mempool page does: seal an order to a `mempool`
# condition, commit its hash through the relayer, wait for the reveal, and
# check the settler's executeBatch landed with the batch's merkle root.
#
#   scripts/bte/mempool-v1-local.sh demo
#
# Keys are anvil's well-known test keys (never real). State under
# .dev-state/bte-v1 (the committee) and .dev-state/mempool-v1 (chain, agents).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
STATE="$ROOT/.dev-state/mempool-v1"
LOGS="$STATE/logs"
PIDS="$STATE/pids"
RPC_PORT=8546
RPC="http://127.0.0.1:$RPC_PORT"
RELAYER_PORT=8799
COORD="${BTE_V1_COORD:-http://127.0.0.1:${BTE_V1_PORT:-8091}}"

# anvil's default accounts 0, 1, 2.
KEY0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
KEY1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
KEY2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
ADDR1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
ADDR2=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC

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
      kill "$(cat "$f")" 2>/dev/null || true
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

chain_up() {
  mkdir -p "$STATE"
  start anvil anvil --port "$RPC_PORT" --block-time 1 --silent
  for _ in $(seq 1 40); do
    if curl -fsS -X POST -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  # Fresh anvil + account 0 at nonce 0 reproduces the addresses in
  # packages/mempool-agents/deployments/31337.json.
  (cd "$ROOT/contracts" && DEPLOYER_PRIVATE_KEY="$KEY0" RELAYER_ADDRESS="$ADDR1" SEARCHER_ADDRESS="$ADDR2" \
    forge script script/DeployMempool.s.sol --rpc-url "$RPC" --broadcast >"$LOGS/contracts.log" 2>&1)
  grep -E '"(pealMempool|pealPool)"' "$LOGS/contracts.log" || { echo "contract deployment failed, see $LOGS/contracts.log" >&2; exit 1; }
}

agents_up() {
  local agents="$ROOT/packages/mempool-agents"
  CHAIN_ID=31337 RELAYER_PRIVATE_KEY="$KEY1" PORT="$RELAYER_PORT" \
    start relayer "$agents/node_modules/.bin/tsx" "$agents/src/relayer.ts"
  CHAIN_ID=31337 DEPLOYER_PRIVATE_KEY="$KEY0" COORDINATOR_URL="$COORD" \
    start settler "$agents/node_modules/.bin/tsx" "$agents/src/settler.ts"
  wait_http "http://127.0.0.1:$RELAYER_PORT/config" 120
}

demo() {
  stop_all
  rm -rf "$STATE"
  "$ROOT/scripts/bte/v1-stack.sh" reset
  chain_up
  agents_up
  RELAYER_URL="http://127.0.0.1:$RELAYER_PORT" COORDINATOR_URL="$COORD" RPC_URL="$RPC" \
    node "$ROOT/scripts/bte/mempool-v1-drive.mjs"
  local rc=$?
  stop_all
  "$ROOT/scripts/bte/v1-stack.sh" down
  return $rc
}

case "${1:-}" in
  demo) demo ;;
  down) stop_all; "$ROOT/scripts/bte/v1-stack.sh" down ;;
  *) echo "usage: $0 demo|down" >&2; exit 2 ;;
esac
