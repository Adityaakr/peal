# Peal Live: a sealed auction anyone can enter with nothing

Status: proposed. Branch `feat/peal-live`.
Grounded 2026-09-03 against the live coordinator, the live chain, and this repo.

## The product

A livestreamer names an item and a close time and gets a link. Viewers open the
link, type an amount and a name, and bid. No wallet, no sign in, no gas, no
signature, no extension. The bid is encrypted in the viewer's browser to the
live 3 of 5 committee, so the host, the audience and Peal's own API hold only a
ciphertext hash. At the close time the whole batch opens at once and the page
ranks it and names the winner.

No escrow. This produces a verifiable winner, not a collected payment.

## Measured facts this rests on

Everything below was checked live on 2026-09-03, not recalled.

| claim | how it was checked | result |
|---|---|---|
| the coordinator is up | `GET peal.network/v0/healthz` | 200 |
| the committee is the one memory records | `GET /v0/committees` | `2d7ce50d…` n=5 t=3 B=64 |
| a browser style seal and reveal works end to end | sealed 3 payloads, waited for the cue | 64 slots, 3 real, all 3 plaintexts correct |
| more than 64 bidders works | `engine.rs:116` pads to a multiple of B and opens `total/b` batches | already true, no work needed |
| Tempo Moderato is live | `eth_chainId` | `0xa5bf` = 42431 |
| gas can be claimed with no key and no backend | `tempo_fundAddress` over bare curl | returned 4 tx hashes |
| `commitSealed` is callable by anyone | `PealMempool.sol:58-60`, deployed `0x387b…6bf9` | emits only an event, writes no storage |
| its selector | viem `toFunctionSelector` | `0x0d915bff` |

### The one that changed the design

Sealing the same bid at three magnitudes:

```
"5"          -> sealed blob 100 b64 chars
"250"        -> sealed blob 104
"1000000000" -> sealed blob 112
```

`ct2` is a `Vec<u8>` (`crates/bte-crypto/src/lib.rs:125`) and the FO body is a
keystream XOR, so the wire length is `69 + payload`. **The number of digits in a
bid is visible before the reveal.** Padding every bid to a fixed width fixes it,
measured:

```
5 / 250 / 1000000000, names of 1, 2 and 26 chars -> 228 b64 chars, all three
```

This is a length policy, not a new algorithm, so it does not touch the "no
custom cryptography" rule.

## Recommendation

### The bidder touches no chain and holds no key

The first design gave every bidder a throwaway key, funded it silently through
`tempo_fundAddress`, and anchored each bid with `commitSealed`. Four independent
reviews said cut it, for four different reasons, and they are all correct:

1. `Sealed` indexes `from` (`PealMempool.sol:42`). One `eth_getLogs` filter
   enumerates every auction a browser ever bid in, timestamped. The anchor meant
   to prove integrity would be the thing that de-anonymises the bidder.
2. `commitSealed` is permissionless and writes no storage. Anyone can emit junk
   hashes under a real condition id, and `verify.ts:158-163` renders unmatched
   commitments as **fail**. Free gas turns the host's verification panel red on
   demand. That is a denial of integrity surface, open to anyone.
3. `tempo_fundAddress` is unauthenticated per address, so a key per bid is a
   faucet drain.
4. It buys nothing anyway, because the value being anchored is
   `resp.ct_hash`, which the coordinator computed (`sdk/src/index.ts:206`). A
   lying coordinator hands back any 32 bytes and the anchor commits to nothing.

So the bidder path is: type, seal in the browser, done. That is also exactly the
flow that was asked for.

### The host sends one transaction, once

At creation the host anchors `sha256(terms)` through the already deployed
`commitSealed`. One transaction, on a key the host already gets from the
existing sign in and self funding path (`auction-create.ts:307` already calls
`fundGas`). It is best effort: if it fails the auction still runs, and the page
says so rather than pretending.

What it proves: the terms existed, in that exact form, before this block. What
it does not prove: that these were the terms anyone honoured. It is labelled as
the former and never dressed as the latter.

### Terms ride in the fragment, with a checksum read out on stream

Terms pack into the URL fragment, so the link is self contained with no storage
and no backend. Fragments never reach a server (`docker/Caddyfile:11-15`).

A forger can edit the terms, create their own condition, anchor their own hash,
and hand out a link that passes every check it can perform on itself. The only
defence is an out of band comparison, and **a livestream is exactly that
channel**: the host's screen shows a short checksum of the terms, and a viewer
compares it to the one their link computes. The use case supplies the missing
piece, which is why this works here and would not work in an emailed link.

### The browser derives its own ciphertext hash

`bte-wasm` exports `ct_hash(sealed) -> hex` (`crates/bte-wasm/src/lib.rs:53-58`)
and the SDK already loads it (`wasm.ts:33`). It has **zero call sites in the
product**. Peal Live is the first, because "your bid is in" should not be the
coordinator's word when the browser is still holding the ciphertext bytes.

### The sealed record

Fixed width, so length leaks nothing:

```
u16 body length | JSON {v, a: auction id, b: amount, n: display name} | zero pad to 96
```

The auction id goes inside the sealed bytes because a ciphertext is not bound to
a condition (`SECURITY.md:38-42`: a posted blob can be replayed into another
condition and will decrypt to the same payload). At reveal, a bid whose inner
auction id does not match is discarded.

### No bidder code

An earlier draft gave each bidder a short code, shown to them, sealed in the
payload. On a livestream a code shown on screen is a bearer credential shown in
public. Dropped. The browser instead remembers the ciphertext hash of the bid it
made, which is public at reveal anyway, and highlights that row as "yours".

## Steelman of the rejected design

**A plain server that stores bids and refuses to serve them before T.** Same
user experience, no wasm, no committee, one afternoon of work.

It loses on one axis: with a server, whoever runs it reads bids early and nobody
can detect it. With BTE the coordinator needs 3 of 5 operator shares.

The honest problem is that **this delta is currently zero in the deployed
system**: the ceremony is a single trusted dealer, and all five operators run in
one container and sign whatever headers they are handed
(`bte-node/src/main.rs:150-193`). So today the simpler design genuinely wins on
merit, and BTE wins only once operators are separately run and check the cue
themselves.

That is not a reason to build the server. It is the reason the two recorded
invariants are launch blockers rather than caveats, and it is why this page will
say what it actually gets instead of what the architecture could give.

## What the page may say, and may not

The editorial rule is already written down at `sealbid-landing.ts:8-15`: the
page may only claim what the deployed system actually does today.

Allowed:
- your bid is encrypted in your browser, and only the ciphertext leaves this page
- the host cannot read a bid before the close, and neither can the other bidders
- opening the batch early takes 3 of the 5 committee operators cooperating
- the committee's keys came from a single trusted setup we ran, so whoever ran
  that machine could read every bid
- the close time is kept by our coordinator's clock, not enforced by the
  operators
- nothing is escrowed, and a bid is not a payment

Forbidden: trustless, nobody can see your bid, decentralized committee, DKG,
zero knowledge, complete privacy, and any claim that bids are unlinkable.

## Assumptions and falsifiers

| assumption | if false | cheapest falsifier |
|---|---|---|
| an audience will type real numbers with no obligation, and the host will honour the top one | the product is dead regardless of the crypto | run one real stream, count joke bids, ask the host if they would honour it |
| a host will do a two click sign in while a viewer will not | the asymmetry the whole design rests on collapses | watch one host attempt it cold |
| bids arriving in a 90 second window stay under a few hundred | batch work grows, though it still functions | load the coordinator with 500 seals into one condition |

## Known and disclosed, not fixed

- The coordinator can reveal early. Recorded invariant, unchanged by this work.
- The host can shill bid from a second browser and it is undetectable. Nothing
  short of a per viewer identity fixes it, and that is the friction being
  removed on purpose. The page claims sealing and ordering, never distinctness
  of bidders.
- The host can walk away from a result. No escrow means no settlement.
- The real bid count is public. `/v0/conditions` already serves `real_count`.

## Roadmap

| # | slice | done signal |
|---|---|---|
| 1 | `packages/live`: record codec, terms codec, checksum, ranking. Pure, no DOM, no network | `pnpm -C packages/live test` green, including the constant length property |
| 2 | `#/live` create: item, close time, rule, link and checksum | a real condition on the live coordinator, link opens |
| 3 | `#/live/<terms>` bid: seal in browser, browser derived ct hash, no wallet | a bid from a second browser lands, `/v0/reveals` 404s before the cue |
| 4 | result: ranked board, dummies filtered, own bid highlighted, honest verify panel | two browsers independently render the same winner |
| 5 | host side terms anchor on Tempo, best effort, plus the copy pass | `Sealed` log present, page states exactly what it proves |

---

## What actually shipped (2026-09-03)

All five slices, on `feat/peal-live`. Nothing committed; the working tree holds it.

### Verified, with the commands

| check | command | result |
|---|---|---|
| pure logic | `packages/live/node_modules/.bin/vitest run --root packages/live` | 116 passed |
| against the live network | `PEAL_LIVE_E2E=1` same command | seals real bids, waits a real cue, right winner |
| the whole flow, two browsers | scripted Chrome against `localhost:5199` proxying `peal.network` | both render the same winner, neither needs a wallet |
| the chain | same, host browser only | anchored in Moderato block 33615250 |
| regression | sdk / actions / auctionkit / explorer attach | 7 / 155 / 25 (4 need anvil) / 27 |
| gate | `tsc --noEmit && vite build` | clean |

The browser run, verbatim:

```
checksum   WGE3 80C0
ana sealed, checksum matched
bo sealed, checksum matched
needed a wallet: false
bids sealed showing: 2
ana sees: ana wins at 125.00 USD
bo  sees: ana wins at 125.00 USD
```

And the forged link, which is the claim the product actually rests on:

```
host says:   terms recorded on Tempo in block 33615250
forged link: these terms are not recorded on Tempo
forged checksum: MYP8 80XG   (the host's was 9T5C CBEX)
```

### Changed from the plan

The plan said the host would sign in to anchor. It does not: the host's browser
mints a throwaway key and funds it through `tempo_fundAddress`, the same keyless
path the bidder path was rejected for. The objections to that path were all
specific to having one key per BIDDER: linkability across auctions through the
indexed `from`, faucet drain, and junk commitments under a shared condition id.
One key, once, for one host, anchoring one hash that is looked up by exact match,
has none of those properties. So creating an auction needs no sign in either.

### Found by attacking it, and fixed

Two rounds of adversarial review against the built code, everything reproduced
before it was believed. Seven defects, all fixed and pinned by tests. The two
that mattered:

- **A 100x overbid.** `parseAmount` stripped every comma, so a viewer typing
  `12,50` sealed 125000 minor units. Most of the world writes a decimal comma,
  the bid is sealed, and it cannot be taken back. Commas are now only accepted
  where a thousands separator can go.
- **A checksum that was not a function of the link.** `canonicalTerms` hashed
  the trimmed title, `unpackTerms` returned the untrimmed one, so padding a
  title with whitespace produced a different link with the same spoken checksum
  and the same on-chain terms hash. That is exactly the swap the checksum
  exists to catch. `unpackTerms` now refuses any link that does not re-pack to
  itself.

XSS, cleanup and double-submit were attacked and were clean: every
interpolation escapes, navigating away stops all polling, and eight rapid
clicks plus an Enter produce one ciphertext.

### Still true, still not fixed, said out loud on the page

The host can shill bid from a second browser and nobody can tell. One person can
bid twice by clearing their storage. Nothing is escrowed. The close is the
coordinator's clock and the dealer is still a single trusted setup. The page
states each of these; none of them is a bug to be fixed at this layer.

---

## What was added after the first five slices

Each of these came from using the thing, which is the only reason any of them
exist. They are listed with what they cost, because several traded something.

### Short links, on chain

`peal.network/shoonya` instead of a hundred and sixty characters of base64.
`PealNames` is live on Tempo Moderato at
`0x98D1a8b4d8C5d36D5D9a357F7fccE17cB0F63D2f`.

A name is claimed once and never moves, not even by the account that claimed it.
That is the whole security argument: a name that can be repointed means the
person who shared a link is also the person who can change where it goes. It
costs reuse, and a name spent on a test is spent.

The address IS the namespace. Redeploying does not migrate names, it starts a
second empty registry, so every link anyone shared stops resolving.

### A ceiling, and a queue instead of a winner

Nothing is escrowed, so a bid is cheap talk and no in-auction mechanism fixes
that. Vickrey does not help: its dominance proof assumes the winner must pay, so
with no obligation the dominant strategy is still to bid infinity and decide
later.

What was built bounds the damage instead. A maximum alongside the reserve, so a
joke bid of ninety nine million cannot take the auction. And the board is a
queue, so a bid nobody honours costs the seller one line rather than the sale.
The pass-over control is local to the seller's device and says so.

### A description, a picture, and contact details

The description and the picture address are part of the terms, so the check code
covers them: a link with different words or a different picture has a different
code. What is not covered is the picture's BYTES. Whoever hosts that image can
serve something else tomorrow and nothing here would notice.

Contact details are the interesting one. Everything sealed into a bid is
published when the batch opens, so a contact field beside the name would be
readable by every other bidder the moment the timer ran out. Hiding it in the
interface and calling it private would be exactly the claim this cannot afford.
So the seller gets a keypair at creation, the public half rides in the terms,
and a bidder encrypts to it. WebCrypto's own ECDH and AES-GCM, joined by its own
deriveKey; no key derivation is written by hand.

The cost is real and cannot be engineered away: the private key is the only
copy, and losing that browser makes every contact detail unreadable by everyone,
including the seller. Anything that let us recover them would let us read them.

### Verification that was quietly not running

The two chain checks reported "no chain endpoint is configured" on every
condition, because they read their endpoint from the mempool relayer, which is
not running. Those are the only non-circular checks the page has.

Fixing the endpoint exposed two more. "Anchored" meant any Sealed log under the
condition id, but `commitSealed` is permissionless, so a stranger could make any
condition look anchored and then fail it, and Peal Live's own terms record did
exactly that. And the seal check treated every commitment as a ciphertext that
should have opened, which a stranger with free gas could use to turn the panel
red.

A live auction went 4/6 to 4/4, and a real mempool condition 3/5 to 5/5 with the
settled root now genuinely checked against the chain.

### The build trap, recorded because it cost two deployments

`forge script --broadcast` sizes the transaction from `eth_estimateGas`, which
on Tempo does not account for the roughly 1000 gas per byte of code that
foundry.toml already documents: 666,270 estimated against 2,680,516 actual. The
`gas_limit` in foundry.toml governs simulation only. Use
`forge create --gas-limit 29000000`.

And the image build had been failing on `ERR_PNPM_IGNORED_BUILDS`: four
`allowBuilds` entries were the literal string "set this to true or false". It
was latent rather than new, because the Docker layer was cached, and a lockfile
change busted that cache.
