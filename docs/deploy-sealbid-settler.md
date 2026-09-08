# Deploying the SealBid settler

The settler is the one service the on-chain auction needs beyond the coordinator
and the static site. Bids are sealed with batched threshold encryption (BTE) to
the committee; the coordinator opens the batch when the condition fires; the
settler is what carries that opened batch onto the chain. Without it, sealed auctions close but never reveal, and
fail to refunds at their reveal deadline. See
[`packages/sealbid-settler`](../packages/sealbid-settler/README.md) for what it
does and [decision 0005](auctionkit/decisions/0005-wire-bte.md) for why it
cannot alter, omit or invent a bid.

## Railway

One service, built from the **repo root** (leave Root Directory empty) because it
imports the `peal-auctionkit` workspace package. Set the service's **Config
File** to `railway/settler.json`, which points at `docker/Dockerfile.settler`.

Variables:

| variable | value |
|---|---|
| `SETTLER_PRIVATE_KEY` | a key that pays gas. On Tempo it claims PathUSD from the chain faucet at boot, so a fresh key is fine. |
| `COORDINATOR_URL` | the coordinator's own domain, not the explorer's |
| `DEMO_COMMITTEE` | `1` on the testnet stack, whose committee keys are the published demo ones |
| `TX_GAS` | a fixed gas limit per write, for example `3000000`. Tempo's estimator under-provisions. |

For a committee whose operators hold their own keys, replace `DEMO_COMMITTEE`
with `COMMITTEE_KEYS` (comma separated) on a machine you control, or better, run
one signer per operator and give the settler a gas key only. That second shape
is slice 8 of the [implementation plan](auctionkit/implementation-plan.md).

## Locally

```sh
SETTLER_PRIVATE_KEY=0x… DEMO_COMMITTEE=1 COORDINATOR_URL=http://localhost:8080 \
  pnpm -C packages/sealbid-settler start
```

`AUCTIONS=0x…,0x…` pins the settler to specific auctions instead of everything
the factory has created, which is the quickest way to watch one auction settle.

## What you should see

For an auction with three sealed bids, in order:

1. `closeCommit ok` once the chain passes the auction's end time.
2. Nothing until the coordinator's condition fires and `/v0/reveals/<id>`
   answers. The settler polls every five seconds.
3. `opened by cond_…: 3 of 3 bid(s) match; registering root …` then
   `registerRevealRoot ok`.
4. `processing 3 reveal(s)` then `processReveals ok`.
5. `finalize ok`. If any bid was voided, this waits out the auction's dispute
   window first and says so once.

A bid logged as `will be voided: <reason>` is a bidder's problem, not the
auction's. Its escrow is refundable through `claim`, and the settlement of every
other bid does not depend on it.
