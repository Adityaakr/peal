#!/usr/bin/env bash
# Peal Links local stack, without Docker.
#
#   scripts/peal-links/stack.sh up      start anvil A and B, put the gateways on them, start the node and the explorer
#   scripts/peal-links/stack.sh down    stop everything started here
#   scripts/peal-links/stack.sh reset   stop, wipe ledger and product state, start
#   scripts/peal-links/stack.sh status  what is running and where
#   scripts/peal-links/stack.sh logs    tail every log
#
# State: .dev-state/peal-links/{pids,logs,data,config.json,deployments.json,
# signers.json}. Proving keys: .dev-params (generated on first start, never
# committed).
#
# Every process is real: the node verifies real proofs against its sqlite
# ledgers; anvil is a real EVM; the gateways are the real contracts. The
# settlement committee is a SINGLE-PROCESS FIXTURE (three of anvil's public
# test keys held by the node, threshold 2), labelled as such by the node.
# PEAL_LINKS_DEV_MINT=1 additionally mounts the labelled dev-mint endpoint
# (Phase C fixture); the default path funds through real deposits.
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
ANVIL_MNEMONIC="test test test test test test test test test test test junk"

# anvil's public test keys. Account 0 owns the gateways; accounts 5, 6 and 7
# are the settlement committee fixture (threshold 2 of 3). Never real funds,
# never a real committee.
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
DEPLOYER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
SIGNER_KEYS='["0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba","0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e","0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"]'
# Sorted ascending, as the gateway requires.
SIGNERS="0x14dC79964da2C08b23698B3D3cc7Ca32193d9955,0x976EA74026E726554dB657fA54763abd0C3a0aa9,0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"

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

port_of() {
  case "$1" in
    anvil-a) echo "$ANVIL_A_PORT" ;;
    anvil-b) echo "$ANVIL_B_PORT" ;;
    node) echo "$NODE_PORT" ;;
    explorer) echo "$EXPLORER_PORT" ;;
  esac
}

stop() {
  local name="$1"
  # Anything still listening on the process's port (an orphan from an
  # earlier run) goes too, so `reset` really starts from empty chains.
  local port
  port=$(port_of "$name")
  if [ -n "$port" ]; then
    for pid in $(lsof -ti tcp:"$port" 2>/dev/null); do
      if [ ! -f "$PIDS/$name.pid" ] || [ "$pid" != "$(cat "$PIDS/$name.pid")" ]; then kill "$pid" 2>/dev/null || true; fi
    done
  fi
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

wait_rpc() {
  local port="$1" name="$2"
  for _ in $(seq 1 60); do
    if curl -fsS -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "http://127.0.0.1:$port" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  echo "$name did not answer on port $port" >&2
  return 1
}

put_gateway() {
  # Runs the Foundry script against one local anvil and prints "gateway token block".
  local port="$1"
  local out
  out=$(cd "$ROOT/contracts" && LINKS_OWNER="$DEPLOYER" LINKS_SIGNERS="$SIGNERS" LINKS_THRESHOLD=2 LINKS_DEPLOY_TEST_TOKEN=1 \
    forge script script/DeployLinksGateway.s.sol --rpc-url "http://127.0.0.1:$port" --private-key "$DEPLOYER_KEY" --broadcast 2>&1) || {
    echo "$out" | tail -20 >&2
    return 1
  }
  local gw tok blk
  gw=$(echo "$out" | grep -E "^\s*gateway " | awk '{print $2}')
  tok=$(echo "$out" | grep -E "^\s*token " | awk '{print $2}')
  blk=$(cast block-number --rpc-url "http://127.0.0.1:$port")
  echo "$gw $tok $blk"
}

place_contracts() {
  # Fresh chains mean fresh reserves: ledger and product state from an
  # earlier run would be liabilities with nothing behind them, so they go.
  rm -rf "$DATA"
  mkdir -p "$DATA"
  if ! command -v forge >/dev/null 2>&1; then
    echo "forge not found; gateways not placed, namespaces stay unavailable" >&2
    cp "$CONFIG" "$STATE/config.json"
    return
  fi
  echo "$SIGNER_KEYS" > "$STATE/signers.json"
  local a b
  a=$(put_gateway "$ANVIL_A_PORT")
  b=$(put_gateway "$ANVIL_B_PORT")
  read -r gw_a tok_a blk_a <<< "$a"
  read -r gw_b tok_b blk_b <<< "$b"
  echo "chain A gateway $gw_a token $tok_a (from block $blk_a)"
  echo "chain B gateway $gw_b token $tok_b (from block $blk_b)"
  # Test funds for anvil accounts 0..2 on both chains (100,000 tUSD each).
  for acct in 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; do
    cast send "$tok_a" "faucet(address,uint256)" "$acct" 100000000000 --rpc-url "http://127.0.0.1:$ANVIL_A_PORT" --private-key "$DEPLOYER_KEY" >/dev/null
    cast send "$tok_b" "faucet(address,uint256)" "$acct" 100000000000 --rpc-url "http://127.0.0.1:$ANVIL_B_PORT" --private-key "$DEPLOYER_KEY" >/dev/null
  done
  python3 - "$CONFIG" "$STATE/config.json" "$gw_a" "$tok_a" "$blk_a" "$gw_b" "$tok_b" "$blk_b" "$STATE/signers.json" <<'PY'
import json, sys
src, dst, gw_a, tok_a, blk_a, gw_b, tok_b, blk_b, signers = sys.argv[1:]
cfg = json.load(open(src))
for ns in cfg["namespaces"]:
    if ns["chain_id"] == 31337:
        ns.update(gateway=gw_a.lower(), token_address=tok_a.lower(), start_block=max(0, int(blk_a) - 5), enabled=True)
    elif ns["chain_id"] == 31338:
        ns.update(gateway=gw_b.lower(), token_address=tok_b.lower(), start_block=max(0, int(blk_b) - 5), enabled=True)
cfg["signer_keys_file"] = signers
cfg["signer_threshold"] = 2
json.dump(cfg, open(dst, "w"), indent=2)
PY
  cat > "$STATE/deployments.json" <<EOT
{"31337":{"gateway":"$gw_a","token":"$tok_a","start_block":$blk_a},"31338":{"gateway":"$gw_b","token":"$tok_b","start_block":$blk_b}}
EOT
}

cmd_up() {
  if command -v anvil >/dev/null 2>&1; then
    start anvil-a anvil --port "$ANVIL_A_PORT" --chain-id 31337 --block-time 1 --mnemonic "$ANVIL_MNEMONIC" --silent
    start anvil-b anvil --port "$ANVIL_B_PORT" --chain-id 31338 --block-time 1 --mnemonic "$ANVIL_MNEMONIC" --silent
    wait_rpc "$ANVIL_A_PORT" anvil-a
    wait_rpc "$ANVIL_B_PORT" anvil-b
  else
    echo "anvil not found (install Foundry); EVM chains not started" >&2
  fi
  ( cd "$ROOT" && cargo build --release -p peal-links-node 2>&1 | tail -1 )
  if [ ! -f "$STATE/config.json" ] || [ ! -f "$STATE/deployments.json" ] || ! running anvil-a; then
    place_contracts
  else
    # anvil is in-memory: if it restarted, the recorded contracts are gone.
    gw=$(python3 -c "import json;print(json.load(open('$STATE/deployments.json'))['31337']['gateway'])")
    code=$(cast code "$gw" --rpc-url "http://127.0.0.1:$ANVIL_A_PORT" 2>/dev/null || echo 0x)
    if [ "$code" = "0x" ] || [ -z "$code" ]; then place_contracts; fi
  fi
  start node env PEAL_LINKS_LISTEN="127.0.0.1:$NODE_PORT" "$ROOT/target/release/peal-links-node" --config "$STATE/config.json"
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
  rm -rf "$DATA" "$STATE/config.json" "$STATE/deployments.json"
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
