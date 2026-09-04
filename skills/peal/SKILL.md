---
name: peal
description: Use when adding sealed submissions or timed disclosure to an application — data that is encrypted on the client, unreadable by anyone including the server, and opens by itself at a deadline. Covers sealed bid auctions, private voting, encrypted mempools, commit-reveal without the reveal step, and agent actions that must not be front run. Also use when the user mentions Peal, peal.network, sealed bids, or "open at a time". Do not use for encryption at rest or for hiding data permanently.
---

# Peal

Peal collects encrypted submissions and opens them all at the same moment.

A caller encrypts a payload in their own process and sends only the ciphertext.
Nobody can read it early — not the other participants, not the application
owner, not the operators who run the network. When the deadline arrives, every
submission opens at once.

**The reveal is not a participant's move.** In a commit-and-reveal scheme,
whoever is losing can decline to reveal. Here the network opens the batch on its
own when the condition fires, so there is nothing to withhold.

## When this applies

Any flow where people submit something others must not see yet:

- sealed bid auctions and tenders
- private voting, where a running tally would sway later voters
- encrypted mempools, so a searcher cannot read the queue and jump it
- procurement and quote rounds
- prediction tournaments and bounty submissions
- token allocations and fair launches
- actions by autonomous agents that must not be front run

If the rule is "not before this moment, then everybody at once", it fits.

## Getting started

No signup, no API key, no payment, no wallet for the people submitting. The
client is one file served from the site itself, so there is nothing to install.

```js
import { peal } from 'https://peal.network/peal.js';
```

Everything is also plain JSON over HTTP from any language. Two of the three
calls work with `curl`; sealing needs code because that is where the encryption
happens, on the caller's machine.

## The three calls

```js
// 1. name the moment. Nothing is encrypted yet.
const round = await peal.createRound({ opensIn: 3600, tag: 'my-app' });

// 2. encrypt locally and hand over the ciphertext
const seal = await peal.seal('the submission', round.id);

// 3. after the deadline, everything at once
const payloads = await peal.getPayloads(round.id);
```

`GET /v1/rounds/{id}` answers 200 at every stage with a `status` of `open`,
`closing`, `opened` or `stalled`. It carries an ETag: send `If-None-Match` while
waiting and unchanged polls cost a 304.

## Sealed bid auctions

The most common thing built on this. Read
`reference/auctions.md` before writing auction code — the money rules matter and
are easy to get wrong.

```js
const auction = await peal.createAuction({
  title: 'Signed tour poster',
  closesIn: 3600,
  currency: 'USD',           // decimals come with the code
  reserveMinor: 10_00,       // nothing below this can win
  maximumMinor: 500_00,      // nothing above this can win
});

await peal.bid(auction.id, { amountMinor: 125_00, name: 'ana' });

const { winner, queue, bids, discarded } = await peal.results(auction.id);
```

Every auction with a title returns a `bid_url`: a hosted page where somebody can
read the terms and bid, so a working auction needs no interface of your own.

## Mistakes to avoid

These are the ones that produce code which looks right and is wrong.

1. **Never send a plaintext payload.** There is no API field that accepts one
   and there never will be. Encrypting on the server would move the encryption
   to the wrong side of the network and delete the only property Peal has.

2. **Money is integers of minor units.** `12.50` in a two decimal currency is
   `1250`. Never a float. Pass a currency code and the decimals come with it;
   the yen has none and the Kuwaiti dinar has three.

3. **Pad payloads, or the length leaks the value.** The ciphertext body is a
   keystream over the plaintext, so a sealed blob's length is public the moment
   it is submitted. `peal.js` pads for you. If you write your own client and
   skip it, a sealed bid auction has its bids in order of size before anything
   opens.

4. **The seller's contact private key never leaves their machine.** Pass the
   public half as `contactPublicKey`. Sending the private half would let the
   server read every contact detail. There is no recovery if it is lost, and
   that is the point.

5. **A time needs an offset.** `'2026-09-12T18:00'` means a different instant in
   every timezone and is refused with `invalid_time`. Pass a `Date`, unix
   seconds, or a string with `Z` or an offset.

6. **A picture must be `https://`.** `http:`, `javascript:` and `data:` are
   refused rather than sanitised.

7. **A slot count is not a participant count.** Batches are padded to 64 with
   decoys, so a quiet round does not announce how few took part. Decoys are
   flagged `is_dummy` and excluded from `seals` and from auction results.

8. **404 before the deadline is correct.** For an auction, `bids` is `null`
   rather than an empty list, so "not open yet" cannot be read as "nobody bid".

## Errors

Every failure is RFC 9457 problem+json with a stable `code` to branch on and a
`field` when one input is at fault. Branch on `code`; `detail` is for people and
its wording is not part of the contract.

```json
{ "type": "…", "title": "invalid request", "status": 400,
  "code": "invalid_maximum", "detail": "…", "field": "maximum_minor" }
```

Full list in `reference/errors.md`.

## Reference files

- `reference/api.md` — every endpoint, parameters and responses
- `reference/auctions.md` — auction integration, the money rules, contact details
- `reference/errors.md` — error codes and limits

## The trust model, stated plainly

Payloads are encrypted against the committee's public parameters, whose digest
the client verifies before use. The coordinator stores ciphertexts and holds no
key that opens one on its own. Opening a batch takes three of five operators;
two cannot. Reveals are checkable afterwards: payloads come back with positions
derived from the ciphertext hashes, plus a merkle root over the set, so a batch
cannot be reordered or quietly edited.

Do not tell a user their data is unreadable by everyone forever. It is
unreadable until the deadline, and then it is public. That is the product.
