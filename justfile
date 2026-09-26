# bte task runner. Recipes fill in as phases land.

default:
    @just --list

setup:
    rustup target add wasm32-unknown-unknown
    git submodule update --init --recursive
    cargo fetch
    pnpm install

build:
    cargo build --workspace

fmt:
    cargo fmt --all

lint:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets -- -D warnings

test:
    cargo test --workspace

# Bring up the full dev network: coordinator + fresh ceremony + 5 nodes.
compose-up:
    docker compose -f docker/docker-compose.yml up -d --build
    @echo "waiting for coordinator health on port ${BTE_PORT:-8080}…"
    @for i in $(seq 1 60); do curl -fsS http://localhost:${BTE_PORT:-8080}/v0/healthz >/dev/null 2>&1 && break; sleep 1; done
    @curl -fsS http://localhost:${BTE_PORT:-8080}/v0/healthz >/dev/null

compose-down:
    docker compose -f docker/docker-compose.yml down -v

# Drive seal -> freeze -> reveal against the live stack and assert payloads.
test-e2e:
    cargo run --release -p bte-cli -- e2e --coordinator http://localhost:${BTE_PORT:-8080} --expect-verified-at-least 3

# Local dev ceremony (writes gitignored .dev-ceremony/).
ceremony:
    BTE_KEYSTORE_PASS=${BTE_KEYSTORE_PASS:-devnet-pass} cargo run --release -p bte-cli -- ceremony --n 5 --t 3 --b 64 --out .dev-ceremony

# Run the explorer against the coordinator (BTE_URL overrides the target).
explorer:
    BTE_URL=${BTE_URL:-http://localhost:${BTE_PORT:-8080}} pnpm -C packages/explorer dev

# Sealed-bid auction. Boots the dev network first if it is not up.
demo:
    @curl -fsS http://localhost:${BTE_PORT:-8080}/v0/healthz >/dev/null 2>&1 || just compose-up
    BTE_DEVNET_URL=http://localhost:${BTE_PORT:-8080} node demos/sealed-bid/index.ts

# Same auction with operator 2 byzantine and operator 5 killed mid-flow.
# Asserts: 1 rejected share flagged, reveal succeeds from 3 honest shares.
demo-byzantine:
    #!/usr/bin/env bash
    set -euo pipefail
    docker compose -f docker/docker-compose.yml -f docker/docker-compose.byzantine.yml up -d --build
    BTE="http://localhost:${BTE_PORT:-8080}"
    for i in $(seq 1 60); do curl -fsS "$BTE/v0/healthz" >/dev/null 2>&1 && break; sleep 1; done
    BTE_DEVNET_URL="$BTE" node demos/sealed-bid/index.ts --expect-rejected 1 --expect-verified 3 &
    DEMO=$!
    sleep 20
    echo "-- killing operator 5 mid-flow --"
    docker compose -f docker/docker-compose.yml stop node5
    wait $DEMO
    echo "-- restoring honest network --"
    docker compose -f docker/docker-compose.yml up -d node2 node5

bench:
    cargo bench -p bte-crypto

publish-dry:
    pnpm -C packages/sdk build
    pnpm -C packages/sdk test
    cd packages/sdk && npm publish --dry-run

# Boot the production compose locally (Caddy on 80/443 with internal CA).
prod-up:
    docker compose -f docker/docker-compose.prod.yml up -d --build
    @echo "waiting for the edge…"
    @for i in $(seq 1 90); do curl -fsSk https://localhost/v0/healthz >/dev/null 2>&1 && break; sleep 1; done
    curl -fsSk https://localhost/v0/healthz
    @echo "\nexplorer: https://localhost  api: https://localhost/v0"

prod-down:
    docker compose -f docker/docker-compose.prod.yml down -v

# Anchored auction: Sepolia when SEPOLIA_RPC_URL+ANCHOR_PRIVATE_KEY are set,
# local anvil otherwise. (forge build must have run once.)
demo-anchored:
    cd contracts && forge build
    node demos/sealed-bid-anchored/index.ts
