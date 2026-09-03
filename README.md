# Peal, the programmable disclosure network

Peal is reveal-later encryption as a network. You seal a payload to a committee,
name a cue (a time, a block, an event), and when the cue fires the whole batch
opens at once, for everyone, guaranteed. Nothing is readable early, not by the
operators and not by us, and no one ever sends a reveal transaction.

This repo is three things:

- **the disclosure network** ([`bte-sdk`](packages/sdk), a Rust coordinator and
  operator nodes) that any dapp can integrate for sealed bids, hidden votes, or
  fair launches,
- **Peal Live** ([`peal-live`](packages/live)), a sealed auction anyone can enter
  with no wallet, no sign in and no gas, built as the smallest thing that puts
  the network in front of people who have never heard of it, and
- **the encrypted mempool**, a live end-to-end demo that puts Peal in front of a
  swap and shows a real MEV sandwich vanish, on a real chain, with every step
  verifiable.

```ts
import { BteClient } from 'bte-sdk';

const client = new BteClient({ url: 'http://localhost:8080' });
const conditionId = await client.condition({ in: 60 });
await client.seal('sealed bid: 42', conditionId);

const reveal = await client.waitForReveal(conditionId);
for (const slot of reveal.slots.filter((s) => !s.isDummy)) {
  console.log('revealed on cue:', slot.text);
}
```

That is the whole integration. Your users never send a reveal transaction, so
there is no "the winner never opened their commitment", no reveal-deadline
griefing, and no trusted auctioneer sitting on plaintexts.

---

## Peal Live

A seller names an item and a close time and gets a link. Anyone who opens it
types a number and hits bid: no wallet, no sign in, no gas, nothing to install.
The bid is sealed in the bidder's own browser, so the seller cannot read it
before the close and neither can anyone else bidding. At the close the whole
batch opens at once and the page ranks it.

The point is what it does not need. A bidder brings nothing, and a seller does
not either: the terms ride in the URL fragment, so an auction is a link and
needs no backend to exist. `peal.network/shoonya` works because
[`PealNames`](contracts/src/PealNames.sol) on Tempo maps a name to those terms,
once and permanently.

Three things it deliberately does not claim:

- **Nothing is escrowed.** It settles who bid the most, not the payment. The
  board is a queue rather than a winner, so a bid nobody honours costs the
  seller one line rather than the sale.
- **The close is our coordinator's clock**, not something the operators check.
- **The committee's keys came from one setup we ran**, so this is a fair reveal
  rather than a trustless one, and the pages say so in those words.

Contact details are the exception that proves the rule: everything sealed into a
bid is published when the batch opens, so they are encrypted to a key only the
seller holds rather than hidden in the interface.
[`packages/live`](packages/live) is the pure half, 217 tests, no DOM and no
network.

## The encrypted mempool

The flagship demo. It is the same swap sent into two mempools at once, live on
**Tempo Testnet (Moderato, chain 42431)**, and you sign nothing.

- On the **public** side your order sits in the mempool in the clear. A real
  searcher bot reads it and wraps a sandwich around it: it buys ahead of you to
  push the price, lets you fill at the worse rate, and sells back. You get less
  than your quote, and the difference becomes its profit.
- On the **peal** side your order is sealed through the real committee. The chain
  sees only a ciphertext hash, so there is nothing to sandwich. At the cue the
  whole batch opens at once, and your swap fills at the quoted price.

Nothing here is a mock-up. Both pools are real contracts, the searcher is a real
bot with its own key, and the sealed order is settled on-chain by
`PealMempool.executeBatch`, which re-derives the batch's merkle root and rejects
anything that is not the revealed batch. The browser signs nothing; a relayer
sponsors both submissions.

### What the page shows

1. **A DEX swap.** Pick an amount and a direction (USDC to ETH or back), see the
   live quote, hit swap.
2. **The outcome, side by side.** The public lane comes back sandwiched, the peal
   lane comes back whole, and a banner shows exactly how much Peal kept for you.
   Both lanes start from identical reserves (the relayer resets them before every
   swap), so the only difference between them is the sandwich.
3. **How the public mempool takes your money.** A three-step pipeline animating
   the sandwich: your order is public, the searcher jumps ahead, you fill worse.
4. **How Peal keeps your order private.** A four-step pipeline animating the
   batched threshold encryption, filled with the real artifacts from your swap:
   the ciphertext hash, the 3-of-5 committee, your order hidden as 1 real slot
   among 63 decoys, the verified operator shares, the merkle root, and the
   on-chain settlement. A link opens the full batch, slot by slot, with every
   operator's pairing check.

Everything is verifiable on the Tempo explorer. The deployed contract addresses
are in [`packages/mempool-agents/deployments/42431.json`](packages/mempool-agents/deployments/42431.json).

### The contracts

Four Solidity contracts, 23 Foundry tests, in [`contracts/`](contracts):

| contract | role |
|---|---|
| `DemoToken` | mintable ERC-20 (mUSDC, mETH); reserves are token balances |
| `SwapPool` | constant-product x*y=k pool, 0.3% fee, gated to one builder; `adminSetReserves` resets both lanes to identical reserves each swap |
| `PublicBuilder` | models an unprotected mempool: orders are deferred and broadcast in the clear, and `sandwich()` wraps one atomically |
| `PealMempool` | `commitSealed` emits only a hash; `executeBatch` re-derives the batch's merkle root (matching the coordinator and the SDK byte for byte) and settles only the revealed batch |

### The services

Three off-chain agents in [`packages/mempool-agents`](packages/mempool-agents),
plus the SPA:

- **relayer**, the sponsored no-wallet gateway. Submits the public order (in the
  clear) and the peal commitment (a hash) on the visitor's behalf, resets both
  pools to identical reserves before each swap (`/prepare`), and serves the read
  endpoints the browser needs.
- **searcher**, a real bot with its own key. Reads each public order, sizes a
  sandwich to your slippage floor, and submits real front-run and back-run
  transactions when profitable. On the peal lane it sees only a hash and does
  nothing.
- **settler**, the coordinator's on-chain arm. Watches the coordinator's reveals
  and calls `executeBatch`, which the contract binds to the revealed batch.

### Run it locally

Point the agents at Tempo and at a running coordinator (a local devnet, or the
hosted one). Keys live in `.secrets/tempo-keys.env` (gitignored) and are read
from the environment. Each key needs pathUSD for gas from the
[Tempo faucet](https://tempo.xyz/developers/docs/quickstart/faucet).

```bash
cd packages/mempool-agents
CHAIN_ID=42431 RELAYER_PRIVATE_KEY=0x..  pnpm relayer   # serves on :8799
CHAIN_ID=42431 SEARCHER_PRIVATE_KEY=0x.. pnpm searcher
CHAIN_ID=42431 DEPLOYER_PRIVATE_KEY=0x.. COORDINATOR_URL=<coordinator> pnpm settler
```

Then the explorer, pointed at the relayer (`VITE_RELAYER_URL`, default
`http://localhost:8799`) and a coordinator for sealing (`VITE_BTE_URL`, or the
vite `/v0` proxy):

```bash
BTE_URL=<coordinator> pnpm -C packages/explorer dev   # open /#/encrypted-mempool
```

To change which swap sizes get sandwiched, adjust the pool depth in one place,
`TARGET_BASE` / `TARGET_QUOTE` in `packages/mempool-agents/src/relayer.ts`
(shallower pool means smaller swaps get sandwiched), and restart the relayer. No
contract redeploy.

### Deploy to Railway

Each service deploys from its own directory. The agents are a standalone image
selected by a `START` env var; the explorer builds the SPA from a repo-root
context. Full recipe, every environment variable, and which key goes where:
[docs/deploy-mempool-railway.md](docs/deploy-mempool-railway.md).

### The honest gap

The committee is dealer-trusted and its operators do not yet verify the cue for
themselves, so today a dishonest operator could read a sealed order early. That
is survivable in a demo, where there is no real money on the table, and it is
exactly the decentralisation work on the roadmap. The cryptography and the
on-chain settlement are real; the committee's trust model is not there yet.

---

## How the disclosure network works

![peal architecture](docs/img/architecture.svg)

Peal is built on commonware's
[batched threshold encryption](https://commonware.xyz/blogs/bte)
([simple-bte](https://github.com/commonwarexyz/simple-bte), paper:
[eprint 2026/760](https://eprint.iacr.org/2026/760) by Guru Vamsi Policharla).

1. **Seal.** Your dapp encrypts a payload in wasm, client-side, to a committee of
   5 operators with threshold 3. The ciphertext costs 64 bytes of overhead and
   can be posted anywhere.
2. **Cue.** A condition fires: a clock time, or an Ethereum block height. The
   batch freezes at 64 slots (padded with marked dummies), positions assigned by
   ciphertext hash. The expensive FFT work starts immediately, before any
   operator has responded.
3. **Reveal.** Each operator posts **one 48-byte share for the whole batch**,
   however many ciphertexts it holds. Every share is publicly verifiable with a
   pairing check. Any 3 valid shares recover all 64 plaintexts at once, published
   with a merkle root you can pin on-chain.

Before the cue nobody can read anything. After it, everybody can. That asymmetry
is the product.

## The numbers

Measured with criterion at B=64, n=5, t=3 (M-series laptop, single process):

| operation | cost |
|---|---|
| seal one payload (client wasm) | 416 µs |
| operator's share, whole batch | 1.16 ms, 48 bytes |
| verify one share (public) | 12 ms |
| pre-decrypt (hidden before shares arrive) | 245 ms |
| finalize after t shares | 37 ms |

In line with the paper's single-thread numbers (121.5 ms @ B=32, 593.63 ms @
B=128). The reveal your users feel is the 37 ms, because the 245 ms was pipelined
while shares were still in flight. None of the encrypted-mempool latency is
crypto: an operator does about 5 ms of work and emits a 48-byte share to open a
whole batch.

## Quickstart (the disclosure network)

Prereqs: rust stable, node 20+, pnpm, docker,
[just](https://github.com/casey/just), wasm-pack. Foundry only for the on-chain
anchor and the mempool contracts.

```bash
git clone https://github.com/Adityaakr/peal-network
cd peal-network
just setup     # toolchain + deps
just demo      # boots a 5-operator network, runs a sealed-bid auction
```

`just demo` starts one coordinator, runs the dealer ceremony, brings up 5
operator nodes, seals 8 bids, and crowns the winner after the 60 second cue. The
explorer (`pnpm -C packages/explorer dev`) shows every condition flipping from
ciphertext hashes to plaintexts, with the per-operator share log. Full
walkthrough: [docs/quickstart.md](docs/quickstart.md).

## Try to break it

- **Read before the reveal.** `GET /v0/reveals/:id` is 404 until the cue. There
  is no plaintext anywhere: the coordinator stores ciphertexts, the operators
  hold Shamir shares of powers of tau. Below t shares, decryption does not exist.
- **Kill n-t operators.** `docker compose stop node4 node5`. The reveal still
  lands: any 3 of 5 shares recover the batch.
- **Kill more.** The condition goes `stalled`, loudly, in the API and the
  explorer. Restart a node and the reveal completes. No silent hangs.
- **Submit garbage shares.** `just demo-byzantine` runs operator 2 with
  `--byzantine`. The bad share fails the public pairing check, is stored flagged,
  never counts toward t, and the reveal succeeds from the 3 honest shares.
- **Maul a ciphertext.** Flip a bit in someone's sealed blob: that one slot is
  flagged corrupt at reveal time, the other 63 are untouched.
- **Restart mid-flow.** Kill the coordinator between freeze and reveal; it
  recomputes the pipelined work and finishes. Nodes are stateless beyond their
  keystore.

## Anchor it on-chain (optional)

`BteAnchor.sol` records ciphertext commitments per condition and lets the
coordinator publish the reveal's merkle root. The SDK recomputes the root from
revealed payloads and checks it against the chain (`verifyAnchor`), so your app
does not have to trust the coordinator's word:

```bash
just demo-anchored   # local anvil, or Sepolia with SEPOLIA_RPC_URL + ANCHOR_PRIVATE_KEY
```

## Trust model, honestly

v0 uses a **single trusted dealer**: `bte-cli ceremony` samples tau, deals Shamir
shares of each power to the operators, publishes public parameters, and drops
tau. A dealer compromised at ceremony time can read everything sealed under that
committee. There is no DKG yet, no resharing, and the committee can censor by
refusing to reveal (you will see it stall; you cannot force it).

What you do NOT have to trust: operators below the threshold learn nothing,
shares are publicly verifiable so a lying operator cannot corrupt a reveal, and
the coordinator never sees plaintext before the cue. Details in
[SECURITY.md](SECURITY.md), every divergence from the paper in
[spec/DEVIATIONS.md](spec/DEVIATIONS.md), the path to trustlessness (DKG,
EIP-2537 on-chain verification, staking) in [spec/ROADMAP.md](spec/ROADMAP.md).

## Repo map

| path | what |
|---|---|
| `crates/bte-crypto` | the only crate touching group elements; wraps simple-bte |
| `crates/bte-coordinator` | registry, condition engine, aggregator, REST, sqlite |
| `crates/bte-node` | operator binary (encrypted keystore, outbound-only) |
| `crates/bte-cli` | ceremony, committee init, e2e driver |
| `packages/sdk` | `bte-sdk` on npm: TS + inlined wasm, zero bundler config |
| `packages/live` | `peal-live`: the pure half of Peal Live, no DOM and no network |
| `packages/explorer` | the disclosure explorer, Peal Live, and the encrypted-mempool demo |
| `packages/auctionkit` | client for the escrowed, on-chain sealed-bid auctions |
| `packages/mempool-agents` | relayer, searcher, settler for the mempool demo |
| `contracts/` | `BteAnchor.sol`, `PealNames.sol`, and the mempool contracts (DemoToken, SwapPool, PublicBuilder, PealMempool) |
| `solana/` | a native Solana program that checks a Peal inclusion proof on chain; self-contained, not deployed |
| `demos/` | sealed-bid auction, byzantine run, anchored variant |
| `docs/deploy-mempool-railway.md` | deploying the mempool demo to Railway |

## Credits

The cryptography is entirely [commonware](https://commonware.xyz)'s work:
[commonwarexyz/simple-bte](https://github.com/commonwarexyz/simple-bte) by Guru
Vamsi Policharla ([eprint 2026/760](https://eprint.iacr.org/2026/760)), used
unmodified as a dependency. Peal adds the network around it: coordinator,
operator nodes, wire formats, SDK, explorer, the on-chain anchor, and the
encrypted-mempool demo.

Apache-2.0. See [NOTICE](NOTICE).
