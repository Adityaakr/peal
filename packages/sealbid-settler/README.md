# sealbid-settler

The committee's on-chain arm for SealBid auctions. It watches the factory for
auctions, closes bidding when the end time passes, waits for the coordinator to
report that the auction's condition has opened, and then registers the reveal
root, processes every revealed bid and finalizes. If the reveal deadline passes
first it triggers the permissionless failure so escrow is refundable.

What it cannot do is the point. Bids are sealed with batched threshold
encryption (BTE); plaintexts come from the committee's threshold decryption, and
the settler never sees a bid before the condition fires; every revealed bid is checked on-chain against the commitment its
bidder posted before the close; the root must cover exactly the committed count;
and the root needs a threshold of committee signatures. See
`docs/auctionkit/decisions/0005-wire-bte.md`.

```sh
SETTLER_PRIVATE_KEY=0x… DEMO_COMMITTEE=1 COORDINATOR_URL=https://… pnpm -C packages/sealbid-settler start
```

| variable | meaning |
|---|---|
| `SETTLER_PRIVATE_KEY` | pays gas. On Tempo it funds itself from the chain faucet at boot. |
| `COMMITTEE_KEYS` | comma-separated operator signing keys. A real deployment runs one signer per operator instead. |
| `DEMO_COMMITTEE=1` | derive the five published testnet keys from `DeploySealBidStack.s.sol`. A prop, and the pages say so. |
| `COORDINATOR_URL` | the Peal coordinator, default `http://localhost:8080` |
| `AUCTIONS` | optional comma-separated auction addresses to watch instead of the factory's listing |
| `TX_GAS` | fixed gas limit per write; Tempo's estimator under-provisions |
| `POLL_MS`, `LISTINGS_MS`, `REVEAL_CHUNK`, `COOLDOWN_MS` | tuning |

Deploy with `docker/Dockerfile.settler` from the repo root (`railway/settler.json`); the walkthrough is [`docs/deploy-sealbid-settler.md`](../../docs/deploy-sealbid-settler.md).
