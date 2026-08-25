# Peal AuctionKit — repository audit

What exists in `peal-network` today, what AuctionKit can build on, and what it
cannot. Every claim here was checked against the code at `b4590c6`, not recalled.

## Working tree at audit time

Branch `feat/private-actions`, clean, at `b4590c6`. No uncommitted user changes
to preserve.

## Baseline (measured before any AuctionKit change)

| suite | command | result |
|---|---|---|
| Rust workspace | `cargo test --workspace` | 14 suites, all pass |
| Contracts | `forge test` | 23 pass, 0 fail |
| peal-actions | `vitest run` | 155 pass |
| bte-sdk | `vitest run` | 7 pass |
| explorer file format | `node packages/explorer/test/attach.test.mjs` | 27 pass |
| extension parser | `node extension/test/parse.test.js` | 20 pass |

**Toolchain note:** Foundry was *not installed* on the audit machine even though
`contracts/foundry.toml` has existed since phase 7. Contracts had therefore not
been compiled or tested locally in recent work. Installed `forge 1.7.1` and
added `OpenZeppelin/openzeppelin-contracts@v5.1.0` (previously only `forge-std`
was vendored). The 23 pre-existing tests pass unchanged.

## Structure

Rust workspace + pnpm workspace, no framework surprises.

| path | what it is | verdict |
|---|---|---|
| `crates/bte-crypto` | the only crate touching group elements; wraps `simple-bte` | **reuse unchanged** |
| `crates/bte-coordinator` | registry, condition engine, aggregator, axum REST `/v0` + `/v1`, sqlite | **extend** |
| `crates/bte-node` | operator binary: poll work, compute share, post | **extend** (close-condition check) |
| `crates/bte-cli` | ceremony, committee init, e2e | **reuse** |
| `packages/sdk` (`bte-sdk`) | TS + wasm seal-only build | **reuse unchanged** |
| `packages/actions` (`peal-actions`) | Private Actions: intents, receipts, adapters | **reuse patterns** |
| `packages/explorer` | vite SPA, hash router | **extend** |
| `packages/mempool-agents` | relayer/searcher/settler for the DEX demo | **reference only** |
| `contracts/` | `BteAnchor`, `PealMempool`, `SwapPool`, `DemoToken`, `PublicBuilder` | **reference + extend** |

## Cryptography — the findings that shape the design

### 1. Trusted dealer, not DKG

`spec/index.md:15-17` states it plainly: a single ceremony generates `tau`,
Shamir-deals shares of each power, publishes params, destroys `tau`. **No DKG.**
`bte-cli ceremony` is the implementation.

Anyone who held `tau` during that ceremony can decrypt every batch under those
parameters, alone, forever. This is the largest production blocker and it is not
fixable inside AuctionKit. DKG is roadmap item 1.

**AuctionKit must not describe itself as trustless.** See `trust-assumptions.md`.

### 2. Multiple batches per auction: already supported

`engine.rs:167` — `for batch_index in 0..(total / b)`. A condition pads to a
multiple of `B` and creates *n* batch rows, each with its own share collection.
`B=64` is the per-batch size, **not** a cap on participants.

So AuctionKit is not limited to 64 bidders. A 200-bid auction becomes 4 batches
of 64 (with padding). No change needed to the batching layer.

### 3. Shares are publicly verifiable — but not *onchain*

`verify_share` (`lib.rs:320`) runs `e(pd_j, g_2) == sum_i e(ct_{i,0}, v_j^i)`.
Real verification, run inline on every submitted share, rejected shares stored
flagged and never used.

That check is a BLS12-381 pairing. **There is no EVM path to it today** —
EIP-2537 precompiles are roadmap item 5 and nothing in `contracts/` verifies a
share. `BteAnchor.sol` anchors a merkle root; it does not verify cryptography.

**Consequence:** AuctionKit cannot verify threshold decryption onchain. It must
use the committee-attested reveal-root adapter the specification describes —
EIP-712 signatures from the snapshotted committee over a merkle root of the
canonical revealed-bid list. This is a real weakening and is documented as such.

### 4. No domain separation in the encryption scheme

`seal(params, payload, rng)` (`lib.rs:169`) takes **no associated data**. It
calls `simple_bte::bte::fo::encrypt(&params.ek, payload, rng)`. There is no AAD,
no epoch binding, no context string.

**Consequence:** domain separation cannot live in the ciphertext envelope. It
must be carried *inside the plaintext* and checked after decryption. Every bid
payload therefore embeds protocol name, version, chainId, auction contract,
auction id, batch index, bid id and encryption epoch, and the reveal path
rejects any decrypted bid whose embedded context does not match the auction it
was decrypted for.

This is weaker than AEAD-style binding: a ciphertext could be *replayed* into
another auction's batch, but on decryption its embedded context will not match
and it is rejected. Detection, not prevention. Documented in
`encryption-flow.md`.

### 5. Payload size is not a constraint

`MAX_PAYLOAD_BYTES = 5 MiB`. A bid payload is a few hundred bytes. Ample.

### 6. Where plaintext lives

- **Before reveal:** nowhere. `GET /v0/reveals/:id` 404s for the entire pending
  window; the coordinator holds only ciphertext. Verified by the existing
  invariant-4 test and by `intents_v1.rs::no_plaintext_before_reveal`.
- **After reveal:** `reveals.payloads_blob` (`db.rs:61`) stores the revealed
  payloads as JSON. This is by design — reveal is public.

For auctions this is acceptable *because revealed bids become public anyway*.
But AuctionKit must not add any pre-reveal plaintext path, and the bid API must
refuse convenience plaintext fields.

### 7. Ciphertext availability is a single sqlite file

`ciphertexts.sealed_blob` in one coordinator database. **This is the weakest
operational link.** If that file is lost between commit and reveal, bids cannot
be decrypted and the auction must fail to refunds.

AuctionKit mitigates by registering the ciphertext hash onchain at bid time, so
loss is *detectable and attributable*, and by making the refund path
permissionless on reveal-deadline expiry. It does not make the blob itself
replicated. Documented honestly rather than solved.

## Existing contracts

| contract | relevance |
|---|---|
| `PealMempool.sol` | **closest prior art.** Commits to a ciphertext hash, then settles a revealed batch in committed order, re-deriving the coordinator's merkle root and requiring it to match. The pattern AuctionKit generalises. |
| `BteAnchor.sol` | commit/revealRoot anchoring on Sepolia |
| `SwapPool.sol`, `DemoToken.sol`, `PublicBuilder.sol` | DEX demo support |

`PealMempool` has a single trusted `coordinator` address that supplies ordered
plaintexts. AuctionKit must not inherit that: a single trusted settler is exactly
what a threshold committee is supposed to remove. AuctionKit requires *t* EIP-712
signatures from the snapshotted committee instead.

## Reuse / extend / missing

**Reuse unchanged:** `bte-crypto` (seal, partial, verify_share, recover), the
ceremony, `bte-sdk` wasm sealing, the `/v0` REST surface, the merkle
construction in `merkle.rs`, the deterministic freeze ordering.

**Extend:** coordinator (auction tables + `/v1/auctions`), node (verify the
close condition from chain state before releasing a share — today it trusts the
coordinator's `frozen` status), explorer (issuer + bidder apps).

**Experimental / reference only:** `packages/mempool-agents`, `SwapPool`,
`PublicBuilder`, the sandwich demo.

**Missing entirely:** every auction contract, the clearing-price algorithm,
escrow, claims, the reveal-root verifier, the committee registry, the indexer,
the relayer, the auction SDK, both UIs, auction receipts.

## What blocks production

1. **Trusted dealer.** Not fixable here. DKG required.
2. **No onchain share verification.** Forces the committee-signature adapter,
   which adds a *t*-of-*n* signing trust assumption on top of the threshold
   decryption assumption.
3. **Single-instance ciphertext availability.**
4. **Node trusts the coordinator's close signal.** Must read finalized chain
   state independently. Fixed by AuctionKit; called out because it is a change
   to existing behaviour.
5. **No contract audit.** Nothing in `contracts/` has been audited.
6. **Committee is operated by one party** in every current deployment. Threshold
   security assumes independent operators; five processes on one machine is not
   that.

## Duplicated / unfinished, noted

- `packages/actions` has both a Rust and a TypeScript copy of the lifecycle
  graph, hand-mirrored and pinned by tests on both sides. Deliberate, documented.
- Private Actions has known gaps (server-side signature verification, receipt
  assembly). Unrelated to AuctionKit; not touched by this milestone.
