# Deploying the encrypted-mempool demo to Railway

The demo (`#/encrypted-mempool`) is five moving parts. Deploy each as its own
Railway service so they scale and restart independently.

```
 explorer (static SPA)  ──/v0──▶  coordinator (existing devnet)
        │                              ▲
        └──── HTTP ────▶ relayer ──┐   │ reveals
                        searcher    │   │
                        settler ────┴───┘ (watches coordinator, settles on Tempo)
```

| service    | directory                 | what it is                                    |
|------------|---------------------------|-----------------------------------------------|
| coordinator| `docker/Dockerfile.railway` (`railway/devnet.json`) | the BTE devnet (already deployed) |
| relayer    | `packages/mempool-agents` | sponsored, no-wallet gateway + `/prepare`     |
| searcher   | `packages/mempool-agents` | the real sandwich bot                         |
| settler    | `packages/mempool-agents` | opens the sealed batch on-chain               |
| explorer   | `packages/explorer`       | the DEX + comparison + pipelines (static SPA) |

All on-chain state lives on **Tempo Moderato (chain 42431)**; the contract
addresses are committed in `packages/mempool-agents/deployments/42431.json`.

## Secrets

The three keys are in `.secrets/tempo-keys.env` (gitignored, never pushed). Set
them as Railway **service variables**, not in the repo:

- relayer service: `RELAYER_PRIVATE_KEY`
- searcher service: `SEARCHER_PRIVATE_KEY`
- settler service: `DEPLOYER_PRIVATE_KEY` (deployer == coordinator/settler)

Each key needs pathUSD for gas on Tempo (the faucet gives 1M; that is plenty).

## 1-3. The agents (relayer, searcher, settler)

One image, one directory, three services. On Railway create three services, each
with **root directory `packages/mempool-agents`** (it has a `Dockerfile`), and
set the `START` variable to pick which agent runs.

Shared variables (all three):

```
CHAIN_ID=42431
TX_GAS=8000000
```

Per-service variables:

| service  | START      | key variable            | extra                                                   |
|----------|------------|-------------------------|---------------------------------------------------------|
| relayer  | `relayer`  | `RELAYER_PRIVATE_KEY`   | Railway injects `PORT`; expose the service publicly     |
| searcher | `searcher` | `SEARCHER_PRIVATE_KEY`  | none                                                    |
| settler  | `settler`  | `DEPLOYER_PRIVATE_KEY`  | `COORDINATOR_URL=<coordinator base url>`                |

The relayer is the only one that serves HTTP (`/config`, `/state`, `/prepare`,
`/public-swap`, `/commit`, `/public-result`, `/peal-result`). Give it a public
domain; note its URL for the explorer's `VITE_RELAYER_URL`.

Do NOT run the keeper in production: `/prepare` resets both pools before each
swap, and a background keeper would risk resetting them mid-swap.

## 4. The explorer (static SPA)

**Recommended: run the explorer as its own service.** The devnet-in-a-box image
(`docker/Dockerfile.railway`) also serves the explorer, but rebuilding it for a
UI change means the full coordinator/node/cli Rust build (10+ min). Splitting the
static site out lets UI changes deploy in a few minutes and auto-update on push.

`packages/explorer/Dockerfile` builds the wasm SDK + the SPA and serves it, no
coordinator binaries. The image serves through Caddy (`packages/explorer/Caddyfile`)
rather than `serve -s`, because the build also writes a prerendered HTML file for
every developer page (`dist/developers/<page>/index.html`, from
`scripts/prerender-docs.mjs`) and Caddy's `try_files` prefers that file over the
shell. A reader with no JavaScript, which is most agent fetchers, gets the article;
the app boots over it in a browser. The devnet-in-a-box edge does the same
through the coordinator (`names.rs` prefers the prerendered file too). The explorer imports the `bte-sdk` workspace package, so
the build context is the **repo root** (leave Root Directory empty). Point the
service at this Dockerfile: set the service's **Config File** to
`railway.explorer.json`, set `RAILWAY_DOCKERFILE_PATH=packages/explorer/Dockerfile`,
or set the Dockerfile path in the dashboard (Settings -> Build).

The coordinator and relayer URLs are inlined at build time, so set them as
**build variables**:

```
VITE_BTE_URL=<coordinator base url>        # the devnet service's own railway domain (serves /v0, sends CORS)
VITE_RELAYER_URL=<relayer base url>        # the relayer service's public URL
```

Because the standalone explorer is no longer behind the devnet Caddy, `/v0` is
now cross-origin; that is fine, the coordinator sends permissive CORS. When you
move a custom domain (e.g. `peal.network`) onto this explorer service, give the
devnet/coordinator service its own railway domain and point both `VITE_BTE_URL`
and the settler's `COORDINATOR_URL` at that domain (not the explorer's).

It serves the built SPA on `PORT` with an SPA fallback so hash routes resolve.

## Order of operations

1. Coordinator is already live (existing devnet).
2. Deploy the **relayer**, give it a domain, note its URL.
3. Deploy **searcher** and **settler** (settler needs `COORDINATOR_URL`).
4. Build the **explorer** with `VITE_BTE_URL` (coordinator) and
   `VITE_RELAYER_URL` (relayer), then open its domain.

## Changing the sandwich threshold

The pool depth is a one-line dial in `packages/mempool-agents/src/relayer.ts`
(`TARGET_BASE` / `TARGET_QUOTE`); `/prepare` resets both pools to it before every
swap. Shallower pool = smaller swaps get sandwiched. Redeploy the relayer only;
no contract redeploy.
