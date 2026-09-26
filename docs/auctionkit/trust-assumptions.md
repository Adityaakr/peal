# Peal AuctionKit — trust assumptions

Read this before writing any marketing copy, and before running an auction with
value in it.

## What AuctionKit actually promises

> Bids remain encrypted until the auction closes. After the close, bids are
> revealed together, the auction calculates a deterministic clearing price,
> allocations settle onchain, and participants receive verifiable receipts.

Every word of that is defensible. Everything below bounds it.

## What it does NOT promise

**Not trustless.** Peal v0 uses a trusted-dealer ceremony, not DKG. See below.

**Not funding privacy.** Quote-token escrow is an ordinary public ERC-20
transfer. An observer sees *which address escrowed how much quote token*, which
upper-bounds that bidder's `quantity × maxPrice`. AuctionKit encrypts the *split*
between quantity and price, and hides it until close — it does not hide the
money. A bidder who escrows exactly 100,000 USDC has told the world their
maximum commitment.

The UI must say this. Do not describe AuctionKit as providing "private bids"
without qualification; the accurate phrase is "sealed bid parameters".

**Not Sybil resistance.** `maxQuantityPerAddress` caps one address. It does not
cap one person, who can use ten addresses. Per-wallet caps are a UX guardrail,
not a security control.

**Not audited.** No contract in this repository has had an external audit.

## The trust assumptions, ranked

### 1. Trusted dealer — the big one

A single machine generated `tau`, Shamir-dealt shares of each power, published
the public parameters, and destroyed `tau`.

If that machine was compromised, or the operator kept `tau`, **every bid in
every auction under those parameters is decryptable by one party, at any time,
forever** — including before the auction closes.

There is no application-level mitigation. Software checks in the committee node
cannot help: an attacker holding `tau` does not need the committee.

Status: **local and testnet only.** A production AuctionKit requires DKG
(roadmap item 1). See `production-readiness.md`.

### 2. Threshold collusion

With `t=3` of `n=5`: any three operators who collude before the close can
decrypt the entire batch early and bid against what they read.

This is inherent to threshold encryption at *t*=3, not a bug. It is why operator
independence matters more than any code in this repository. Five processes on
one machine — which is how the local devnet runs — provides **zero** threshold
security. It is a functional test of the protocol, not a security posture.

### 3. Committee signatures over the reveal root

Because this repository has not yet benchmarked onchain share verification, the
contract does not check threshold decryption itself. (EIP-2537 *did* ship on
Ethereum mainnet with Pectra in May 2025 — an earlier draft of these docs wrongly
said otherwise. See `decisions/0001-reveal-root.md` for why the adapter is still
in use and what would replace it.)

Instead the snapshotted committee signs an EIP-712 message over a merkle root of
the canonical revealed-bid list, and the contract requires *t* unique signatures
from members of the *snapshotted* set.

This adds a trust assumption on top of the decryption one:

- **What a colluding threshold can do:** register a reveal root for a bid list
  that is not what was actually decrypted.
- **What it cannot do:** substitute a *different plaintext for an existing bid*.
  Every revealed bid is checked against the salted commitment the bidder posted
  onchain at commit time. A wrong plaintext fails `keccak256` against a
  commitment that predates the reveal.
- **What it can do:** *omit* bids. Omission is caught by requiring
  `processedBidCount == committedBidCount` before settlement, so an omitted bid
  blocks settlement entirely rather than silently changing the clearing price.
  The auction then fails to refunds at the reveal deadline.

So: a malicious committee can **halt** an auction. It cannot **steal** from one.
Censorship becomes a liveness failure with a permissionless refund path, which
is the correct failure direction.

### 4. Ciphertext availability

Ciphertexts live in the coordinator's sqlite database. One file, one machine, not
replicated.

If it is lost between commit and reveal, no threshold of operators can decrypt
anything — the shares operate on ciphertext headers that no longer exist.

Mitigation is detection, not prevention: the ciphertext hash is registered
onchain at bid time, so loss is provable, and the reveal-deadline refund path is
permissionless so funds are never trapped. **This is an availability
single-point-of-failure and is a production blocker.**

Since [0005](./decisions/0005-wire-bte.md) this assumption is live rather than
stated: every bid's plaintext, salt included, exists only inside its ciphertext
and in the bidder's browser as a convenience. The bidder is no longer a liveness
dependency; the coordinator's store is.

### 5. No domain separation in the cipher

`seal()` accepts no associated data (`crates/bte-crypto/src/lib.rs:169`). Domain
separation is therefore carried *inside the plaintext* and checked after
decryption.

A ciphertext from auction A can be replayed into auction B's batch. On
decryption, its embedded `(chainId, auctionContract, auctionId, bidId, epoch)`
will not match and it is rejected — but the rejection happens at reveal, not at
submit. Detection, not prevention. The onchain commitment binds the same fields,
so a replayed ciphertext cannot be matched to a valid commitment either.

### 6. Relayer and coordinator

The coordinator orders batches and the relayer submits settlement transactions.
Neither is trusted with funds:

- Batch positions are a pure function of the ciphertext set (existing invariant
  6), so the coordinator has no ordering discretion to sell.
- Settlement is computed onchain from the reveal root; the relayer only pays
  gas. Anyone can relay.
- Claims are pull-based. A relayer that never runs delays settlement; it cannot
  redirect a payout.

### 7. Admin keys

There is deliberately **no admin sweep function**. Fee configuration is
snapshotted into each auction at creation and cannot change afterwards. Pausing,
if enabled, must never block refunds.

### 8. The settler

Bids are hidden by batched threshold encryption (BTE), not by anything the
settler does. `packages/sealbid-settler` closes bidding, registers the reveal
root, processes reveals and finalizes. It cannot alter a bid (each is checked against its
commitment), omit one (the root must cover the committed count) or invent a
root (threshold signatures). On the testnet deployment it derives the demo
committee's signing keys, which makes it the committee for signing purposes;
that is the prop the pages already describe, not a new assumption. A real
deployment gives it a gas key only.

## Summary table

| assumption | if it fails |
|---|---|
| Dealer destroyed `tau` | every bid, every auction, decryptable by one party |
| Fewer than 3 of 5 operators collude | early decryption; front-running of the auction |
| Operators are independent | as above — colocated operators give no threshold security |
| Fewer than 3 sign a false reveal root | auction can be halted (not stolen from) |
| Coordinator's sqlite survives to reveal | auction fails to refunds |
| Quote token is a standard ERC-20 | escrow accounting breaks; mitigated by allowlist |
| Contracts are correct | unaudited; this is the residual risk an audit exists to reduce |

AuctionKit removes the auctioneer's ability to see bids early and to reorder
them. It does not remove any row above.
