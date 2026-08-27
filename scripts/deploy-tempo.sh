#!/usr/bin/env bash
# Deploy the SealBid stack to Tempo.
#
# Three Tempo-specific constraints, each of which cost a failed attempt and none
# of which is in Tempo's own docs:
#
#  1. Gas is paid in PathUSD, not a native token. eth_getBalance is hardcoded.
#  2. A single transaction is capped at 30,000,000 gas, separately from the 500M
#     block limit. Asking for more is rejected outright.
#  3. eth_estimateGas returns roughly the Ethereum cost, while Tempo charges
#     ~1000 gas per byte of code and 250k per new storage slot. That is ~10x
#     under for a large deploy and ~100x under for a storage-heavy call, so a
#     single --gas-estimate-multiplier cannot correct both. Every transaction
#     here carries an explicit limit instead.
#
# And one client-side constraint: the 15.4KB implementation takes long enough
# that forge create and a synchronous cast send both time out waiting for the
# receipt, even though the transaction succeeds. So everything is sent async and
# polled.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

RPC="${TEMPO_RPC:-https://rpc.moderato.tempo.xyz}"
KEY=$(python3 -c "import json;d=json.load(open('.secrets/hoodi-deployer.json'));w=d[0] if isinstance(d,list) else d;print(w['private_key'])")
OWNER=$(cast wallet address --private-key "$KEY")
GAS=29000000

# Send, then poll. Returns the deployed address.
send_create() {
  local code="$1"
  local tx
  tx=$(CAST_ASYNC=true cast send --rpc-url "$RPC" --private-key "$KEY" --gas-limit "$GAS" --create "$code" 2>&1 | tail -1)
  await_contract "$tx"
}

send_call() {
  local to="$1"; shift
  local tx
  tx=$(CAST_ASYNC=true cast send --rpc-url "$RPC" --private-key "$KEY" --gas-limit "$GAS" "$to" "$@" 2>&1 | tail -1)
  await_status "$tx"
}

await_contract() {
  local tx="$1" i
  for i in $(seq 1 120); do
    local out
    out=$(cast receipt "$tx" --rpc-url "$RPC" 2>/dev/null || true)
    if echo "$out" | grep -q "^status"; then
      echo "$out" | grep -q "status *1" || { echo "tx $tx FAILED" >&2; exit 1; }
      echo "$out" | grep "^contractAddress" | awk '{print $2}'
      return
    fi
    sleep 4
  done
  echo "timed out waiting for $tx" >&2; exit 1
}

await_status() {
  local tx="$1" i
  for i in $(seq 1 120); do
    local out
    out=$(cast receipt "$tx" --rpc-url "$RPC" 2>/dev/null || true)
    if echo "$out" | grep -q "^status"; then
      echo "$out" | grep -q "status *1" || { echo "tx $tx FAILED" >&2; exit 1; }
      return
    fi
    sleep 4
  done
  echo "timed out waiting for $tx" >&2; exit 1
}

bytecode() {
  python3 -c "import json;print(json.load(open('contracts/out/$1'))['bytecode']['object'])"
}

# Constructor args are appended to the creation bytecode.
with_args() {
  local code="$1"; shift
  echo "${code}$(cast abi-encode "constructor($1)" "${@:2}" | sed 's/^0x//')"
}

echo "deployer $OWNER"

REGISTRY="${REGISTRY:-$(send_create "$(bytecode CommitteeRegistry.sol/CommitteeRegistry.json)")}"
echo "registry       $REGISTRY"

IMPL="${IMPL:-$(send_create "$(bytecode SealedBidAuction.sol/SealedBidAuction.json)")}"
echo "implementation $IMPL"

FACTORY=$(send_create "$(with_args "$(bytecode AuctionFactory.sol/AuctionFactory.json)" "address,address" "$IMPL" "$REGISTRY")")
echo "factory        $FACTORY"

SALE=$(send_create "$(with_args "$(bytecode PermitToken.sol/PermitToken.json)" "string,string,address" "Peal Demo Sale" "PEALD" "$OWNER")")
echo "saleToken      $SALE"

QUOTE=$(send_create "$(with_args "$(bytecode PermitToken.sol/PermitToken.json)" "string,string,address" "Peal Demo USD" "DUSD" "$OWNER")")
echo "quoteToken     $QUOTE"

FAUCET=$(send_create "$(with_args "$(bytecode DemoFaucet.sol/DemoFaucet.json)" "address,uint256,uint64" "$QUOTE" 5000000000000000000000000 300)")
echo "faucet         $FAUCET"

MEMBERS=()
for i in 0 1 2 3 4; do
  HEX=$(python3 -c "print('peal-demo-committee-'.encode().hex() + format($i,'064x'))")
  MEMBERS+=("$(cast wallet address --private-key "$(cast keccak 0x$HEX)")")
done
SORTED=$(printf '%s\n' "${MEMBERS[@]}" | tr 'A-F' 'a-f' | sort | paste -sd, -)

send_call "$REGISTRY" 'registerCommitteeSet(uint16,address[])' 3 "[$SORTED]"
SET_ID=$(cast call "$REGISTRY" 'computeSetId(uint16,address[])(bytes32)' 3 "[$SORTED]" --rpc-url "$RPC")
echo "committeeSetId $SET_ID"

send_call "$QUOTE" 'mint(address,uint256)' "$FAUCET" 500000000000000000000000000
send_call "$SALE" 'mint(address,uint256)' "$OWNER" 500000000000000000000000000
echo "faucet filled, sale minted"

BLOCK=$(cast block-number --rpc-url "$RPC")
echo
echo "{\"chainId\":42431,\"registry\":\"$REGISTRY\",\"implementation\":\"$IMPL\",\"factory\":\"$FACTORY\",\"factoryBlock\":$BLOCK,\"saleToken\":\"$SALE\",\"quoteToken\":\"$QUOTE\",\"faucet\":\"$FAUCET\",\"committeeSetId\":\"$SET_ID\"}"
