# 0005 — Bids are sealed with batched threshold encryption, and the bidder keeps nothing

**Status:** accepted · **Date:** 2026-09-08

## Context

Until this decision the live auction did not use Peal. Bids were salted keccak
commitments; the salt lived only in the bidder's browser; the contract's
`ciphertextHash` slot was filled with a keccak of the salt; and nothing ever
sealed anything or revealed a real user's bid. The landing page said so, in
the "honest limits" section, which is how an outside reader put it plainly:
the flagship demo was commit-reveal, the exact scheme the rest of the site
argues against.

Everything else on the site already sealed through the SDK to the real
committee: Peal Live, the encrypted mempool, the playground. The auction was
the one exception, because the AuctionKit build stopped after the contract
slices and before slice 6 (`implementation-plan.md`).

## Decision

Wire batched threshold encryption (BTE), the primitive the whole network is
built on and the one every other page already uses, into the auction with no
contract change. Sealing means BTE from here on: a bid is encrypted under the
committee's public parameters to a condition, and only a threshold of operators
producing shares after the cue can open it. The salted commitment stays, but as
the binding between a decrypted bid and its bidder, not as the thing hiding it.

1. **Every auction is sealed to one coordinator condition.** The create page
   opens a condition that fires at the auction's `endTime`, tagged `sealbid`,
   before it creates the contract. The condition's id rides in
   `Config.encryptionEpoch` verbatim: an id is `cond_` plus 24 hex characters,
   29 ASCII bytes, so it fits in the bytes32 with zero padding
   (`packages/auctionkit/src/condition.ts`). A bidder's browser goes from the
   on-chain config to the condition it must seal to with no lookup table, and
   because the reveal-root digest already includes the epoch, a root signed for
   one condition cannot be replayed against an auction sealed to another.

2. **The bid plaintext carries everything the reveal needs, salt included.**
   `PEALBID1 || abi.encode(chainId, auction, bidder, quantity, tick, salt,
   bidVersion)`, 232 bytes, sealed in the browser with the SDK
   (`payload.ts`). The salted commitment stays on-chain unchanged; it is what
   binds a decrypted plaintext to a bidder, and share verification never
   replaces that. The salt now exists in two places, the ciphertext and a local
   convenience record, and losing the second costs nothing.

3. **The real ciphertext hash goes on-chain.** `commitBid` receives sha256 of
   the sealed blob as the coordinator computed it. This is what the settler
   joins on: opened slot to committed bid, by hash, with no say-so.

4. **A settler drives the reveal**, modelled on the mempool settler
   (`packages/sealbid-settler`). It closes bidding at `endTime`, waits for the
   condition to open, runs `planReveal` (`settle.ts`) to build one leaf per
   committed bid, collects a threshold of committee signatures over the
   digest, and calls `registerRevealRoot`, `processReveals` and `finalize`.
   Past the reveal deadline it calls `failOnRevealTimeout` so escrow is never
   trapped.

5. **A bid that does not open to what was committed gets a void entry, not a
   halt.** `registerRevealRoot` requires the root to cover exactly
   `committedBidCount`, and `finalize` requires every bid processed. So the
   tree always has one leaf per committed bid; a bid whose ciphertext is not
   in the batch, is not a bid, names another auction or bidder, or does not
   match its commitment gets a placeholder entry the contract voids
   (decisions/0004). Its escrow stays refundable and everyone else settles.

6. **Auctions created before this convention cannot take a sealed bid.** Their
   epoch is a hash, not an id. The bid page shows no form for them and says
   why; the settler logs once and lets them fail to refunds at their deadline.
   There is deliberately no fallback to a bidder-held secret.

## What this changes in the trust model

- **Removed:** the bidder as a liveness dependency. Nobody has to come back,
  keep a file, or send a reveal transaction.
- **Removed:** the seller's or anyone's ability to learn a bid before the
  close from the bidder's side. Before, the split was hidden only by the
  bidder holding the salt; now it is hidden by the committee's threshold.
- **Unchanged:** the committee's keys came from one setup we ran (trusted
  dealer), the committee on the testnet deployment is a prop with derivable
  signing keys, escrow leaks the bid's size, and the root is attested by
  committee signatures rather than verified on-chain. The settler process
  on the demo stack holds those derivable signing keys; a real deployment runs
  one signer per operator and the settler holds only a gas key.
- **Made real:** trust assumption 4, ciphertext availability. It was stated
  before and did not apply, because nothing was sealed. Now the coordinator's
  sqlite holds every bid's ciphertext between commit and reveal, and losing it
  fails the auction to refunds.

## What is next

- **Slice 8, node side.** Operators sign the reveal root with keys they hold
  and refuse to produce a share before the auction's close, rather than
  trusting the coordinator's clock. Then `DEMO_COMMITTEE=1` goes away.
- **Slice 8b.** Replace `registerRevealRoot` with on-chain share
  verification. Tempo Moderato has the EIP-2537 precompile (probed directly:
  `G1ADD` at `0x0b` returns 128 zero bytes, a control address returns empty),
  and decisions/0003 measured the gas. The unmeasured piece is putting the
  verification key shares on-chain.
- **Slice 7.** More than 64 bids is more than one batch. The coordinator
  already splits; the settler reads one reveal per condition and needs to be
  checked against a multi-batch reveal before an auction of that size runs.
- **The demo auction** at `ACTIVE_DEMO.auction` predates this decision and
  takes no bids now. Create a new one from the create page and point
  `ACTIVE_DEMO` at it.

## Tests

- `condition.test.ts`: round trip, refusal of non-ids, null for the epochs
  older auctions carry.
- `payload.test.ts`: fixed width, round trip, commitment agreement, junk
  rejected without throwing.
- `merkle.test.ts`: matches the hand-built tree the contract was first proven
  against; every proof verifies for every size up to 70.
- `settle.test.ts`: matched bids reveal; a missing ciphertext, a foreign
  auction, a swapped bidder, an altered payload and a non-bid each become a
  void entry with a reason; determinism; contiguous ids enforced.
- `e2e.test.ts` (anvil) now places bids with real payloads and settles through
  `planReveal`, so the tree is proven against the contract's own
  `processReveals` whenever anvil is present.
