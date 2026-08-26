#!/usr/bin/env bash
# Send demo tokens and gas to a bidder on Hoodi.
#
#   ./scripts/hoodi-faucet.sh 0xYourWalletAddress
#
# DUSD is the auction's quote token and is what escrow is paid in. It is
# owner-mintable demo money with no value. ETH is only for gas.
#
# Testnet only. The key it reads is a throwaway deployer key in .secrets/,
# which is gitignored and holds nothing but faucet ETH.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

TO="${1:?usage: hoodi-faucet.sh <address>}"
RPC="${HOODI_RPC_URL:-https://rpc.hoodi.ethpandaops.io}"
QUOTE=0xfE4315435fC84c30b84D9316a3EE37b48FFBc40E   # DUSD, the auction quote token
AMOUNT="${DUSD_AMOUNT:-100000000000000000000000}"  # 100,000 DUSD
GAS="${GAS_AMOUNT:-0.05ether}"

KEY=$(python3 -c "import json;d=json.load(open('.secrets/hoodi-deployer.json'));w=d[0] if isinstance(d,list) else d;print(w['private_key'])")

echo "minting DUSD to $TO"
cast "send" "$QUOTE" 'mint(address,uint256)' "$TO" "$AMOUNT" --private-key "$KEY" --rpc-url "$RPC" >/dev/null

# Only top up gas if they have none: this faucet is not a bank.
BAL=$(cast balance "$TO" --rpc-url "$RPC")
if [ "$BAL" = "0" ]; then
  echo "sending $GAS for gas"
  cast "send" "$TO" --value "$GAS" --private-key "$KEY" --rpc-url "$RPC" >/dev/null
else
  echo "already funded with $(cast from-wei "$BAL") ETH; skipping gas"
fi

echo "DUSD: $(cast call "$QUOTE" 'balanceOf(address)(uint256)' "$TO" --rpc-url "$RPC")"
echo "ETH : $(cast from-wei $(cast balance "$TO" --rpc-url "$RPC"))"
