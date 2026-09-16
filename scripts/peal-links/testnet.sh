#!/usr/bin/env bash
# Peal Links on a public testnet (Ethereum Sepolia by default).
#
#   scripts/peal-links/testnet.sh deploy   put the gateway and the faucet test token on the testnet (once; needs a funded deployer)
#   scripts/peal-links/testnet.sh up       start the testnet node (single-node mode, :8795) and an explorer on :5174 pointed at it
#   scripts/peal-links/testnet.sh down     stop them
#   scripts/peal-links/testnet.sh status   node status
#
# State: .dev-state/peal-links/sepolia/{deployer.key, signers.json, deployments.json, config.json, data/}.
# The deployer key and the signer keys never enter git (.dev-state is ignored).
#
# Real chain, test funds: the token is a faucet ERC-20 with no value. The
# settlement committee is the labelled single-process fixture (three keys
# generated here, threshold 2), refused by the node with a mainnet namespace.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="$ROOT/.dev-state/peal-links"
TN="$STATE/sepolia"
PIDS="$STATE/pids"
LOGS="$STATE/logs"
CONFIG="${PEAL_LINKS_TESTNET_CONFIG:-$ROOT/config/peal-links.sepolia.json}"
RPC="${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
NODE_PORT="${TESTNET_NODE_PORT:-8795}"
EXPLORER_PORT="${TESTNET_EXPLORER_PORT:-5174}"
DEPLOYER_KEY_FILE="$STATE/sepolia-deployer.key"
export PATH="$HOME/.foundry/bin:$PATH"

mkdir -p "$TN/data" "$PIDS" "$LOGS"

running() { [ -f "$PIDS/$1.pid" ] && kill -0 "$(cat "$PIDS/$1.pid")" 2>/dev/null; }

start() {
  local name="$1"; shift
  if running "$name"; then echo "$name already running (pid $(cat "$PIDS/$name.pid"))"; return; fi
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

signers() {
  # Three settlement keys for the testnet fixture, generated once.
  if [ ! -f "$TN/signers.json" ]; then
    cast wallet new --number 3 --json | python3 -c '
import json, sys
ws = json.load(sys.stdin)
keys = [w["private_key"] for w in ws]
addrs = sorted(w["address"] for w in ws)
open(sys.argv[1], "w").write(json.dumps(keys))
open(sys.argv[2], "w").write(",".join(addrs))
' "$TN/signers.json" "$TN/signers.addr"
    chmod 600 "$TN/signers.json"
  fi
  cat "$TN/signers.addr"
}

cmd_deploy() {
  [ -f "$DEPLOYER_KEY_FILE" ] || { echo "no deployer key at $DEPLOYER_KEY_FILE" >&2; exit 1; }
  local key deployer bal
  key=$(cat "$DEPLOYER_KEY_FILE")
  deployer=$(cast wallet address --private-key "$key")
  bal=$(cast balance "$deployer" --rpc-url "$RPC")
  echo "deployer $deployer balance $bal wei on chain $(cast chain-id --rpc-url "$RPC")"
  if [ "$bal" = "0" ]; then echo "fund the deployer first (a Sepolia faucet)" >&2; exit 1; fi
  if [ -f "$TN/deployments.json" ]; then
    echo "already deployed: $(cat "$TN/deployments.json")"; return
  fi
  local addrs out gw tok blk
  addrs=$(signers)
  # The Foundry script is the same one the local stack uses.
  out=$(cd "$ROOT/contracts" && LINKS_OWNER="$deployer" LINKS_SIGNERS="$addrs" LINKS_THRESHOLD=2 LINKS_DEPLOY_TEST_TOKEN=1 \
    forge script script/DeployLinksGateway.s.sol --rpc-url "$RPC" --private-key "$key" --broadcast --slow 2>&1) || {
    echo "$out" | tail -30 >&2
    exit 1
  }
  gw=$(echo "$out" | grep -E "^\s*gateway " | awk '{print $2}')
  tok=$(echo "$out" | grep -E "^\s*token " | awk '{print $2}')
  blk=$(cast block-number --rpc-url "$RPC")
  echo "gateway $gw token $tok (block $blk)"
  echo "{\"chain_id\":11155111,\"gateway\":\"$gw\",\"token\":\"$tok\",\"start_block\":$blk,\"deployer\":\"$deployer\",\"signers\":\"$addrs\"}" > "$TN/deployments.json"
  write_config
}

write_config() {
  python3 - "$CONFIG" "$TN/config.json" "$TN/deployments.json" "$TN/signers.json" "$RPC" "$NODE_PORT" <<'PY'
import json, sys
src, dst, dep, signers, rpc, port = sys.argv[1:]
cfg = json.load(open(src))
d = json.load(open(dep))
for ns in cfg["namespaces"]:
    if ns["chain_id"] == d["chain_id"]:
        ns.update(gateway=d["gateway"].lower(), token_address=d["token"].lower(), start_block=max(0, d["start_block"] - 2), enabled=True, rpc_url=rpc)
cfg["listen"] = f"127.0.0.1:{port}"
cfg["signer_keys_file"] = signers
cfg["signer_threshold"] = 2
json.dump(cfg, open(dst, "w"), indent=2)
PY
  echo "config written: $TN/config.json"
}

cmd_up() {
  [ -f "$TN/deployments.json" ] || { echo "deploy first: scripts/peal-links/testnet.sh deploy" >&2; exit 1; }
  ( cd "$ROOT" && cargo build --release -p peal-links-node 2>&1 | tail -1 )
  write_config
  start testnet-node env PEAL_LINKS_LISTEN="127.0.0.1:$NODE_PORT" "$ROOT/target/release/peal-links-node" --config "$TN/config.json"
  wait_http "http://127.0.0.1:$NODE_PORT/healthz" testnet-node
  start testnet-explorer env LINKS_URL="http://127.0.0.1:$NODE_PORT" pnpm -C packages/explorer dev --port "$EXPLORER_PORT" --strictPort
  wait_http "http://localhost:$EXPLORER_PORT/" testnet-explorer
  echo
  echo "explorer  http://localhost:$EXPLORER_PORT/#/bonsai/app   (Sepolia)"
  echo "node      http://127.0.0.1:$NODE_PORT/links/v1/status"
  echo "gateway   $(python3 -c "import json;print(json.load(open('$TN/deployments.json'))['gateway'])")   token $(python3 -c "import json;print(json.load(open('$TN/deployments.json'))['token'])")"
}

cmd_down() { stop testnet-explorer; stop testnet-node; }

cmd_status() {
  for name in testnet-node testnet-explorer; do
    if running "$name"; then echo "$name: running (pid $(cat "$PIDS/$name.pid"))"; else echo "$name: stopped"; fi
  done
  curl -fsS "http://127.0.0.1:$NODE_PORT/links/v1/status" 2>/dev/null | head -c 600 && echo || true
}

case "${1:-}" in
  deploy) cmd_deploy ;;
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) echo "usage: $0 deploy|up|down|status" >&2; exit 2 ;;
esac
