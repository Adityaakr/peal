# deploying bte on Railway

Railway's auto-detection (Railpack) cannot build this repo: it sees the root
Cargo.toml, assumes a plain Rust app, never installs pnpm, and picks `pnpm dev`
as the start command. Every service must be switched to **Dockerfile builds**.
The repo already ships the right Dockerfiles.

Also: `bte-sdk`, `bte-examples`, `bte-demo-sealed-bid`, and
`bte-demo-sealed-bid-anchored` are a library and scripts, not servers.
**Delete those services.** You want exactly seven: 1 coordinator, 5 operator
nodes, 1 web (explorer + edge).

## config-as-code (the repo now carries the build settings)

- `railway.json` (repo root): the DEFAULT config, set up for the **web**
  service (Dockerfile.web + /v0/healthz healthcheck). A service linked to this
  repo with no custom config path picks it up on the next deploy.
- `railway/coordinator.json`: for the coordinator service. In its
  Settings -> Config-as-code, set the path to `railway/coordinator.json`.
- `railway/node.json`: for each node service, path `railway/node.json`.
  Start command is plain `bte-node`; give each service `BTE_OPERATOR_ID=N`.

IMPORTANT: if you previously typed a custom build command or start command in
the dashboard (e.g. `pnpm --filter bte-explorer build` / `pnpm dev`), CLEAR
those fields. Dashboard overrides fight the config file, and Railpack custom
commands are meaningless under the Dockerfile builder.

## 0. run the ceremony locally (the dealer never lives in the cloud)

```bash
BTE_KEYSTORE_PASS='<strong passphrase>' just ceremony   # writes .dev-ceremony/
```

Keep `params.bin`. Each `operator-N.keystore` is an encrypted JSON file whose
contents you will paste into one env var per node service.

## 1. coordinator service

- Settings -> Config-as-code path: `railway/coordinator.json` (sets the
  Dockerfile builder and start command for you).
- Variables:
  - `DATABASE_URL=sqlite:///data/bte.db`
  - `REVEAL_TIMEOUT_SECS=300`
  - `BTE_RATE_RPS=5`, `BTE_RATE_BURST=30`
  - (optional) `SEPOLIA_RPC_URL=...` for at_block conditions
  - (optional) `PEAL_X402_PAYTO=0x...` turns on metered calls. See below.
- Volume: mount at `/data`.
- Networking: it listens on Railway's injected `PORT` automatically. Give it a
  private domain only; the public entry point is the web service.

Register the committee once the coordinator is up (from your machine):

```bash
cargo run --release -p bte-cli -- committee-init \
  --coordinator https://<coordinator-public-or-tunnel-url> \
  --params .dev-ceremony/params.bin
```

(Expose the coordinator publicly just long enough to register, or register
through the web service's `/v0` proxy once it is up.)

## 2. node services (x5)

For N in 1..5, one service each:

- Config-as-code path: `railway/node.json`.
- Variables:
  - `BTE_OPERATOR_ID=N`
  - `BTE_COORDINATOR_URL=http://<coordinator service name>.railway.internal:8080`
    (private networking; the coordinator's internal port is whatever `PORT`
    Railway injected there — pin it by setting `PORT=8080` on the coordinator)
  - `BTE_KEYSTORE_PASS=<the ceremony passphrase>`
  - `BTE_KEYSTORE_JSON=<paste the full contents of operator-N.keystore>`
- No volumes, no public networking. Nodes are outbound-only.

## 3. web service (explorer + edge)

- Uses the root `railway.json` automatically (no config path needed).
- Variables:
  - `BTE_DOMAIN=:8080` (Caddy serves plain HTTP on 8080; Railway's edge does TLS)
  - `BTE_UPSTREAM=<coordinator service name>.railway.internal:8080`
- Networking: public domain, target port 8080.

The explorer is same-origin: it calls `/v0/...` on its own domain and Caddy
proxies to the coordinator over private networking. Share links
(`https://<your-domain>/#/s/...`) work for anyone once this service is public.

## sanity checks

```bash
curl https://<web domain>/v0/healthz          # {"ok":true}
curl https://<web domain>/v0/committees        # your committee digest
```

Then open the domain, seal something in the playground, and watch the five
share dots fill.

(config verified against a green build on 2026-07-07)

## metered calls (x402)

**On by default. Nothing to set.** The payee address is committed in
`crates/bte-coordinator/src/x402.rs` as `DEFAULT_PAY_TO`, because an address is
public by construction and a variable somebody forgets is a feature that turns
itself off on the next deploy.

Override it per deployment only if you need a different payee, for a fork or a
staging environment:

```
PEAL_X402_PAYTO=0x...        # where payments land. An address you control.
```

Only the address goes here or in the source. The private key for it belongs in a
wallet and must never reach Railway, this repo or a log. The server never needs
it: payments only move toward that address, never out of it.

A malformed override turns the gateway off (503) rather than falling back to the
default, because collecting to a different address than the operator configured
is worse than not collecting.

The rest have working defaults for Tempo Moderato and are only worth setting if
you are moving the gateway to another chain or changing the price:

| variable | default | what it is |
| --- | --- | --- |
| `PEAL_X402_ASSET` | `0x20c0…0000` | the token payments are made in. On Tempo this is PathUSD, which is also the gas token. |
| `PEAL_X402_PRICE` | `1000` | price per call, in the asset's smallest unit. With 6 decimals that is 0.001 PathUSD. |
| `PEAL_X402_DECIMALS` | `6` | decimals of the asset, used only to print the price. |
| `PEAL_X402_SYMBOL` | `PathUSD` | shown in the 402 body and on the page. |
| `PEAL_X402_RPC` | `https://rpc.moderato.tempo.xyz` | how the coordinator checks a payment. |
| `PEAL_X402_CHAIN_ID` | `42431` | the chain the payer is told to pay on. |
| `PEAL_X402_NETWORK` | `tempo-moderato` | the network name in the 402 body. |
| `PEAL_X402_EXPLORER` | `https://explore.testnet.tempo.xyz` | used to build the receipt link. |

Check it is on:

```bash
curl -s https://peal.network/v0/x402 | jq '.enabled, .requirements.accepts[0].payTo'
```

`"enabled": true` and your own address means metered calls are live. The switch
at the top of the API reference, and the demo on `#/developers/x402`, both start
working the moment that is true.

Pointing this at a network where the asset has real value is a different
decision from running it on a testnet, and needs the payee to be an address with
a recovery path, not a throwaway.
