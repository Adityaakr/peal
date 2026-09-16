#!/usr/bin/env bash
# The whole Peal Links flow, end to end, from a clean checkout:
#
#   scripts/peal-links/demo.sh
#
# Brings the local stack up (two anvil chains, gateways and test tokens on
# each, the node with its watcher and the labelled signer fixture, the
# explorer), then drives, with real proofs and real chain transactions:
#   1. the SDK bridge flow (deposit on chain A, credit by the watcher, claim,
#      private payment, claim, withdrawal certificate, release on chain A,
#      replay refused, chain B untouched, conservation),
#   2. the two-context browser flow (receiver creates a link and goes
#      offline; payer funds from a wallet and pays; receiver returns, claims,
#      acknowledges, withdraws), with a privacy check on every request the
#      browsers sent.
# PEAL_LINKS_VALIDATORS=3 runs the same flows against three local simplex
# validators. Exit code is non-zero if any step fails. Nothing here moves
# real money.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

step "tooling"
for tool in cargo pnpm forge anvil cast node; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done
[ -f contracts/lib/forge-std/src/Test.sol ] || git submodule update --init --recursive
[ -d node_modules ] || pnpm install --frozen-lockfile
# The explorer imports bte-sdk (Peal's existing SDK), whose dist/ is built
# from crates/bte-wasm and is not committed.
[ -f packages/sdk/dist/index.js ] || pnpm -C packages/sdk build
[ -d packages/links/src/generated ] || node packages/links/scripts/build-wasm.mjs
[ -d "$HOME/Library/Caches/ms-playwright" ] || [ -d "$HOME/.cache/ms-playwright" ] || pnpm -C packages/explorer exec playwright install chromium

step "stack"
scripts/peal-links/stack.sh reset

step "SDK bridge flow (real deposit, private payment, certified withdrawal)"
pnpm -C packages/links exec vitest run test/bridge.test.ts

step "browser flow (two wallets, one-wallet acceptance criteria, real proofs in Web Workers)"
pnpm -C packages/explorer exec playwright test e2e/links-one-wallet.spec.ts

step "done"
curl -s http://127.0.0.1:8790/links/v1/status | python3 -c '
import json, sys
s = json.load(sys.stdin)
print("circuit", s["circuit_id"][:16] + "...", "| setup", s["setup"], "| ledger", s["ledger_mode"], "| signers", s["signer_mode"])
for n in s["namespaces"]:
    print(" ", n["label"], "available" if n["available"] else "unavailable", "gateway", n["gateway"])
for l in s["ledgers"]:
    print("  ledger", l["namespace"][:12] + "...", "receipts", l["receipt_count"], "seq", l["seq"])
'
if [ "${PEAL_LINKS_VALIDATORS:-1}" -gt 1 ]; then
  echo "validators (height, head, applied state root):"
  scripts/peal-links/stack.sh consensus
fi
echo "explorer: http://localhost:5173/#/bonsai"
