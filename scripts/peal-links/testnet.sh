#!/usr/bin/env bash
# Peal Links on a public testnet. One network per invocation, chosen with
# NETWORK (default sepolia):
#
#   NETWORK=sepolia scripts/peal-links/testnet.sh deploy|up|down|status   Ethereum Sepolia (node :8795, explorer :5174)
#   NETWORK=tempo   scripts/peal-links/testnet.sh deploy|up|down|status   Tempo Moderato   (node :8796, explorer :5175)
#
#   deploy   put the gateway and the faucet test token on the chain (once; needs a funded deployer)
#   up       start the network's node (single-node mode) and an explorer pointed at it
#   down     stop them
#   status   node status
#
# State: .dev-state/peal-links/<network>/{signers.json, deployments.json, config.json, data/}
# and the deployer key at .dev-state/peal-links/sepolia-deployer.key (one key,
# the same address on every EVM chain). Nothing under .dev-state enters git.
#
# Real chains, test funds: the token is a faucet ERC-20 with no value. The
# settlement committee is the labelled single-process fixture (three keys
# generated here, threshold 2), refused by the node with a mainnet namespace.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="$ROOT/.dev-state/peal-links"
NETWORK="${NETWORK:-sepolia}"
case "$NETWORK" in
  sepolia)
    CHAIN_ID=11155111
    RPC="${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
    NODE_PORT="${TESTNET_NODE_PORT:-8795}"
    EXPLORER_PORT="${TESTNET_EXPLORER_PORT:-5174}"
    FORGE_EXTRA=(--slow)
    ;;
  tempo)
    CHAIN_ID=42431
    RPC="${TEMPO_RPC:-https://rpc.moderato.tempo.xyz}"
    NODE_PORT="${TESTNET_NODE_PORT:-8796}"
    EXPLORER_PORT="${TESTNET_EXPLORER_PORT:-5175}"
    # Tempo's estimator comes back an order of magnitude low and the chain
    # rejects anything over 30M gas; unused gas is not charged, so every
    # deployment transaction carries an explicit limit.
    FORGE_EXTRA=(--slow)
    CREATE_GAS=29000000
    ;;
  *) echo "unknown NETWORK=$NETWORK (sepolia|tempo)" >&2; exit 2 ;;
esac
TN="$STATE/$NETWORK"
CONFIG="${PEAL_LINKS_TESTNET_CONFIG:-$ROOT/config/peal-links.$NETWORK.json}"
PIDS="$STATE/pids"
LOGS="$STATE/logs"
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
  # Three settlement keys for this network's fixture, generated once.
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
  local key deployer chain
  key=$(cat "$DEPLOYER_KEY_FILE")
  deployer=$(cast wallet address --private-key "$key")
  chain=$(cast chain-id --rpc-url "$RPC")
  [ "$chain" = "$CHAIN_ID" ] || { echo "RPC answers chain $chain, expected $CHAIN_ID" >&2; exit 1; }
  echo "deployer $deployer on chain $chain, balance $(cast balance "$deployer" --rpc-url "$RPC") wei"
  if [ -f "$TN/deployments.json" ]; then
    echo "already deployed: $(cat "$TN/deployments.json")"; return
  fi
  local addrs out gw tok blk
  addrs=$(signers)
  if [ -n "${CREATE_GAS:-}" ]; then
    # Explicit gas per transaction (chains whose estimator is unreliable):
    # the same three steps the Foundry script performs.
    created() {
      # `forge create --json` prints one JSON object with `deployedTo`; keep
      # the whole output for inspection when it does not.
      local log="$TN/forge-create.log"
      # `--constructor-args` swallows every token after it, so it goes last.
      (cd "$ROOT/contracts" && forge create --broadcast --rpc-url "$RPC" --private-key "$key" --gas-limit "$CREATE_GAS" --json "$@") > "$log" 2>&1 || true
      python3 -c 'import json,sys,re
text=open(sys.argv[1]).read()
m=re.search(r"\{.*?\}", text, re.S)
try:
    d=json.loads(m.group(0)) if m else {}
except Exception:
    d={}
if "deployedTo" in d:
    print(d["deployedTo"]); sys.exit(0)
print(text[-1500:], file=sys.stderr); sys.exit(1)' "$log"
    }
    gw=$(created src/links/PealLinksGateway.sol:PealLinksGateway --constructor-args "$deployer" "[$addrs]" 2)
    tok=$(created src/links/TestUSD.sol:TestUSD)
    cast send "$gw" "configureToken(address,bool,uint256)" "$tok" true 1000000000000000000000000 --rpc-url "$RPC" --private-key "$key" --gas-limit "$CREATE_GAS" >/dev/null
    [ "$(cast call "$gw" 'epoch()(uint64)' --rpc-url "$RPC")" = "1" ] || { echo "gateway did not initialise" >&2; exit 1; }
  else
    # The Foundry script is the same one the local stack uses.
    out=$(cd "$ROOT/contracts" && LINKS_OWNER="$deployer" LINKS_SIGNERS="$addrs" LINKS_THRESHOLD=2 LINKS_DEPLOY_TEST_TOKEN=1 \
      forge script script/DeployLinksGateway.s.sol --rpc-url "$RPC" --private-key "$key" --broadcast "${FORGE_EXTRA[@]}" 2>&1) || {
      echo "$out" | tail -30 >&2
      exit 1
    }
    gw=$(echo "$out" | grep -E "^\s*gateway " | awk '{print $2}')
    tok=$(echo "$out" | grep -E "^\s*token " | awk '{print $2}')
  fi
  blk=$(cast block-number --rpc-url "$RPC")
  echo "gateway $gw token $tok (block $blk)"
  echo "{\"chain_id\":$CHAIN_ID,\"gateway\":\"$gw\",\"token\":\"$tok\",\"start_block\":$blk,\"deployer\":\"$deployer\",\"signers\":\"$addrs\"}" > "$TN/deployments.json"
  write_config
}

write_config() {
  # Every namespace on this chain gets the deployed gateway; a namespace
  # with an empty token address is the faucet test token, the others name
  # an existing asset that `allow` put on the gateway's allowlist.
  python3 - "$CONFIG" "$TN/config.json" "$TN/deployments.json" "$TN/signers.json" "$RPC" "$NODE_PORT" <<'PY'
import json, sys
src, dst, dep, signers, rpc, port = sys.argv[1:]
cfg = json.load(open(src))
d = json.load(open(dep))
allowed = {a.lower() for a in d.get("allowed", [])}
for ns in cfg["namespaces"]:
    if ns["chain_id"] != d["chain_id"]:
        continue
    token = (ns.get("token_address") or "").lower() or d["token"].lower()
    enabled = token == d["token"].lower() or token in allowed
    ns.update(gateway=d["gateway"].lower(), token_address=token, start_block=max(0, d["start_block"] - 2), enabled=enabled, rpc_url=rpc)
cfg["listen"] = f"127.0.0.1:{port}"
cfg["signer_keys_file"] = signers
cfg["signer_threshold"] = 2
json.dump(cfg, open(dst, "w"), indent=2)
PY
  echo "config written: $TN/config.json"
}

# Put an existing token on the gateway's allowlist (owner call) and record
# it, so the namespace in the profile that names it becomes enabled.
#   NETWORK=tempo scripts/peal-links/testnet.sh allow 0x20c0... 1000000000000
cmd_allow() {
  local token="$1" cap="${2:-1000000000000}" key deployer gw
  [ -n "$token" ] || { echo "usage: $0 allow <token> [cap]" >&2; exit 2; }
  key=$(cat "$DEPLOYER_KEY_FILE")
  deployer=$(cast wallet address --private-key "$key")
  gw=$(python3 -c "import json;print(json.load(open('$TN/deployments.json'))['gateway'])")
  local gas=()
  [ -n "${CREATE_GAS:-}" ] && gas=(--gas-limit "$CREATE_GAS")
  echo "token $(cast call "$token" 'symbol()(string)' --rpc-url "$RPC") decimals $(cast call "$token" 'decimals()(uint8)' --rpc-url "$RPC") on gateway $gw, cap $cap base units"
  cast send "$gw" "configureToken(address,bool,uint256)" "$token" true "$cap" --rpc-url "$RPC" --private-key "$key" ${gas[@]+"${gas[@]}"} >/dev/null
  python3 - "$TN/deployments.json" "$token" <<'PY'
import json, sys
p, token = sys.argv[1:]
d = json.load(open(p))
allowed = d.setdefault("allowed", [])
if token.lower() not in [a.lower() for a in allowed]:
    allowed.append(token.lower())
json.dump(d, open(p, "w"))
PY
  write_config
  echo "allowed; restart the node (NETWORK=$NETWORK $0 down && ... up) to serve it"
}

cmd_up() {
  [ -f "$TN/deployments.json" ] || { echo "deploy first: NETWORK=$NETWORK scripts/peal-links/testnet.sh deploy" >&2; exit 1; }
  ( cd "$ROOT" && cargo build --release -p peal-links-node 2>&1 | tail -1 )
  write_config
  start "$NETWORK-node" env PEAL_LINKS_LISTEN="127.0.0.1:$NODE_PORT" "$ROOT/target/release/peal-links-node" --config "$TN/config.json"
  wait_http "http://127.0.0.1:$NODE_PORT/healthz" "$NETWORK-node"
  start "$NETWORK-explorer" env LINKS_URL="http://127.0.0.1:$NODE_PORT" pnpm -C packages/explorer dev --port "$EXPLORER_PORT" --strictPort
  wait_http "http://localhost:$EXPLORER_PORT/" "$NETWORK-explorer"
  echo
  echo "explorer  http://localhost:$EXPLORER_PORT/#/bonsai/app   ($NETWORK)"
  echo "node      http://127.0.0.1:$NODE_PORT/links/v1/status"
  echo "gateway   $(python3 -c "import json;print(json.load(open('$TN/deployments.json'))['gateway'])")   token $(python3 -c "import json;print(json.load(open('$TN/deployments.json'))['token'])")"
}

cmd_down() { stop "$NETWORK-explorer"; stop "$NETWORK-node"; }

cmd_status() {
  for name in "$NETWORK-node" "$NETWORK-explorer"; do
    if running "$name"; then echo "$name: running (pid $(cat "$PIDS/$name.pid"))"; else echo "$name: stopped"; fi
  done
  curl -fsS "http://127.0.0.1:$NODE_PORT/links/v1/status" 2>/dev/null | head -c 600 && echo || true
}

case "${1:-}" in
  deploy) cmd_deploy ;;
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  allow) cmd_allow "${2:-}" "${3:-}" ;;
  *) echo "usage: NETWORK=sepolia|tempo $0 deploy|up|down|status|allow <token> [cap]" >&2; exit 2 ;;
esac
