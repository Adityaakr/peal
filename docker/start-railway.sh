#!/bin/sh
# Devnet-in-a-box: coordinator + trusted-dealer ceremony + 5 operator nodes +
# Caddy edge, all in one container. v0 trust model, demo posture: the dealer
# runs in-container. State lives under /bte-state (mount a volume to persist).
set -eu

STATE_DIR="${BTE_STATE_DIR:-/bte-state}"
export BTE_KEYSTORE_PASS="${BTE_KEYSTORE_PASS:-railway-devnet-v0}"
export BTE_COORDINATOR_URL="http://localhost:8090"
export DATABASE_URL="sqlite://${STATE_DIR}/bte.db"
mkdir -p "$STATE_DIR/ceremony"

# Coordinator pinned to 8090 internally; Caddy owns the public port.
BTE_LISTEN="0.0.0.0:8090" bte-coordinator &
COORD_PID=$!

i=0
until curl -fsS http://localhost:8090/v0/healthz >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && echo "coordinator never became healthy" && exit 1
  sleep 1
done

if [ ! -f "$STATE_DIR/ceremony/params.bin" ]; then
  echo "== running the v0 trusted-dealer ceremony (in-container: demo posture) =="
  bte-cli ceremony --n 5 --t 3 --b 64 --out "$STATE_DIR/ceremony"
fi
bte-cli committee-init --coordinator http://localhost:8090 \
  --params "$STATE_DIR/ceremony/params.bin"

for n in 1 2 3 4 5; do
  bte-node --operator-id "$n" --key "$STATE_DIR/ceremony/operator-$n.keystore" &
done

# Caddy serves the explorer + proxies /v0 to the local coordinator, on the
# platform-injected PORT (default 8080, matching the image EXPOSE).
export BTE_DOMAIN=":${PORT:-8080}"
export BTE_UPSTREAM="localhost:8090"
exec caddy run --config /etc/caddy/Caddyfile
