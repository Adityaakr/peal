# quickstart

From zero to a sealed-bid auction in about five minutes.

## prerequisites

- rust stable (`rustup`), plus `rustup target add wasm32-unknown-unknown`
- node 20+ and pnpm
- docker with compose
- [just](https://github.com/casey/just), wasm-pack
- foundry (only for the onchain anchor demo)

## 1. boot the network

```bash
git clone https://github.com/Adityaakr/batched-threshold-encryption && cd batched-threshold-encryption
just setup
just compose-up
```

`compose-up` builds one image and starts:

- a coordinator on :8080 (sqlite in a volume),
- a one-shot ceremony container: the v0 trusted dealer. It generates
  parameters for a 5-operator, threshold-3, batch-64 committee, writes
  encrypted keystores to a shared volume, registers the params, and exits,
- five operator nodes that open their keystores and start polling for work.

Check it: `curl -s localhost:8080/v0/committees | jq`.

## 2. run the demo

```bash
just demo
```

Eight bidders seal `{name, bid}` payloads. The board shows only ciphertext
hashes for 60 seconds. Then the condition fires, the batch freezes (padded to
64 with marked dummies), each operator posts one 48-byte share, the
coordinator verifies each share publicly, combines any three, recovers all 64
slots at once, and the demo crowns the winner.

`just demo-byzantine` runs the same auction while operator 2 posts garbage
shares and operator 5 is killed mid-flow. The reveal still lands; the bad
share shows up flagged in the log.

## 3. watch it in the explorer

```bash
just explorer     # wraps: pnpm -C packages/explorer dev
```

The dev server proxies /v0 to the coordinator, so the browser stays
same-origin. If port 8080 is taken on your machine, run the whole stack on
another port: `BTE_PORT=18080 just compose-up`, then
`BTE_PORT=18080 just explorer` (and `BTE_PORT=18080 just demo`).

Open http://localhost:5173: committee overview, live condition statuses, and
reveal detail with the before/after board, per-operator share log, and
pre-decrypt vs finalize timings.

## 4. seal from your own code

```bash
node examples/ten-lines.ts
```

Or in your app:

```ts
import { BteClient } from 'bte-sdk';
const client = new BteClient({ url: 'http://localhost:8080' });
const conditionId = await client.condition({ in: 60 });
await client.seal('anything up to 2 MiB — text, a PDF, an image', conditionId);
const reveal = await client.waitForReveal(conditionId);
```

Payloads cap at 2 MiB, which covers documents and images; video wants
envelope encryption (seal the key, host the ciphertext elsewhere). Sealing happens client-side in wasm; only the
ciphertext leaves your process. `bte-sdk/verify` verifies operator shares
client-side if you do not want to trust the coordinator's verdicts.

## 5. tear down

```bash
just compose-down
```

Everything (database, ceremony, keystores) lives in docker volumes and is
removed. Next `compose-up` runs a fresh ceremony.
