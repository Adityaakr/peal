---
name: peal
description: Use when adding sealed submissions or timed disclosure to an application. Data encrypted on the client, unreadable by anyone including the server, that opens by itself at a deadline. Covers sealed bid auctions on a marketplace, private voting, encrypted mempools, commit-reveal without the reveal step, and agent actions that must not be front run. Trigger on requests like "add auctions to my marketplace", "let people bid without seeing each other", "collect these privately until Friday", "sealed bids", "open at a time", or any mention of Peal or peal.network. Also covers building the interface for it, matching the app's existing design system, and charging per call with x402 micropayments, for requests like "charge per bid", "pay per call", "meter this API" or "let agents pay without an account". Do not use for encryption at rest or for hiding data permanently.
---

# Peal

Peal collects encrypted submissions and opens them all at the same moment.

A caller encrypts a payload in their own process with batched threshold
encryption (BTE) and sends only the ciphertext. Nobody can read it early: not other participants, not the application owner,
not the operators. At the deadline, every submission opens at once.

**The reveal is not a participant's move.** In commit-and-reveal, whoever is
losing can decline to reveal. Here the network opens the batch on its own, so
there is nothing to withhold.

---

## How to use this skill

The user will describe their application and what they want, not an API call.
Something like:

> add sealed bid auctions to my marketplace for the vintage camera listing,
> closing Monday at 6pm

Work in this order. Do not skip step 1: the integration shape depends entirely
on what is already there.

### 1. Survey the application first

Find out what you are adding to before you write anything.

- **What runs where.** Is there a server (Next.js route handlers, Express,
  Django, Rails), or is this a static front end? This decides how you seal.
  See "Choosing where the code runs" below; get it wrong and nothing works.
- **Where the items live.** A marketplace has a product or listing model. Find
  it. The auction attaches to one of those, and its id is what you store.
- **How state is stored.** You must persist the Peal auction id against your
  own record. Find the database layer, the ORM, the schema or migration folder.
- **Where users act.** The page or component with the buy button is where the
  bid form goes.
- **What it is built out of.** Their UI library, their tokens, and the form
  nearest where you are adding. Three reads, in `reference/ui.md`. An
  integration that works and looks foreign is one the user has to rewrite.
- **How time is handled.** Existing timezone conventions decide how you read
  "Monday at 6pm".

Say what you found before you build, in two or three lines. If the application
has no server and no database, say so, because it changes the design and the
user needs to know.

### 2. Turn the deadline into an exact instant

Users say "Monday at 6pm". The API needs an unambiguous moment. Getting this
wrong closes an auction at the wrong hour, which is not recoverable.

Read `reference/time.md`. In short: resolve the phrase to a concrete date in
the user's timezone, confirm it back to them in full, and pass a `Date` or an
ISO string with an offset. A bare `'2026-09-12T18:00'` is refused, because it
means a different instant in every timezone.

### 3. Choose where the code runs

This is the step that most often produces something that looks right and does
not run.

| Environment | Create and read | Sealing a bid |
| --- | --- | --- |
| Browser | `import { peal } from 'https://peal.network/peal.js'` | same import |
| Node / Bun server | plain `fetch`, no client needed | vendor the file first, see below |
| Python / Ruby / Go | plain HTTP | seal in the browser instead |

**Node cannot import from a URL.** `import { peal } from 'https://…'` throws
`ERR_UNSUPPORTED_ESM_URL_SCHEME`. If you need to seal server side, download it
once and import the local file:

```bash
curl -fsSL -o lib/peal.js https://peal.network/peal.js
```

Bids are usually sealed **in the browser** anyway, which is the point. The
plaintext must never reach a server, including the user's own. Server code
creates the auction and reads results; the browser seals.

### 4. Match the interface to their app

Peal has a design of its own and none of it belongs in somebody else's product.
Read `reference/ui.md` before writing markup: it is three reads, `package.json`,
their config, and one existing component, and then you build out of what they
already have.

Say what you found in one line before you build, so a wrong guess is caught
before it becomes fifteen files:

> Tailwind with shadcn/ui, `--primary` is a dark green, forms put errors under
> the field in `text-destructive`. I will build the bid form the same way.

If the repo has no styling yet, ask which they want rather than guessing. If
they will not choose, `reference/ui.md` has tokens to fall back on.

### 5. Implement

`reference/recipes.md` has working integrations for Next.js, Express, a static
page, and a non-JavaScript backend. Use them rather than inventing a shape.

The minimum for a marketplace listing:

```js
// server: create the auction when the seller starts one, store the id
const auction = await createAuction({ title, closesAt, currency, reserveMinor });
await db.listing.update({ where: { id }, data: { pealAuctionId: auction.id } });

// browser: the bid form
await peal.bid(pealAuctionId, { amountMinor, name });

// server or browser, after the deadline: the ranked board
const { winner, queue, bids } = await peal.results(pealAuctionId);
```

Store `auction.id` against your listing. Everything else is derivable.

**If what they are sealing is not a bid**, a vote, an offer, a model output, a
set of numbers to reconcile, you are writing the payload format yourself and
`peal.bid` does not apply. Use `peal.seal(payload, roundId, { padTo })` and read
"Your own payload, not a bid" in `reference/recipes.md` first. It is four moves,
and skipping any of them produces something that works in a demo and leaks in
production: version the record, pin its width with an explicit `padTo`, put the
round id inside it, and discard on open what does not parse or names another
round. Note the argument order, which is not `bid`'s:

```js
await peal.bid(roundId, { amountMinor: 125_00 });   // id first
await peal.seal(payload, roundId, { padTo: 133 });  // payload FIRST, then id
```

### 6. Verify before you say it is done

Do not report success on code that has not run. `reference/verify.md` is a
script that creates a real auction with a short deadline, bids on it, waits for
it to open, and checks the board. Run it. It takes about a minute and proves
the integration end to end against the live network.

---

## Mistakes that produce code which looks right and is wrong

1. **Never send a plaintext payload.** No API field accepts one. Encrypting on
   your server would move the encryption to the wrong side of the network and
   delete the only property Peal has.

2. **Money is integers of minor units.** `12.50` in a two decimal currency is
   `1250`. Never a float. Pass a currency code and the decimals come with it:
   the yen has none, the Kuwaiti dinar has three.

3. **Pad payloads or the length leaks the value.** The ciphertext body is a
   keystream over the plaintext, so a sealed blob's length is public the moment
   it is submitted. Write your own client without padding and a sealed bid
   auction has its bids in order of size before anything opens.

   `peal.bid` is safe without thinking: the record is a fixed 320 bytes
   whatever the amount. `peal.seal` pads to the next bucket of 256, 1024, 4096,
   16384 or 65536, which is a floor and not a plan, because two payloads in
   different buckets are still told apart. For your own format pass
   `{ padTo: n }` and use the same `n` for every seal in the round.

4. **A `Date` in the wrong timezone.** `setHours(18)` uses the timezone the
   code runs in, which on a server is usually UTC and not the seller's evening.

5. **The seller's contact private key never leaves their machine.** Pass the
   public half as `contactPublicKey`. The private half is the only copy and
   there is no recovery.

6. **A picture must be `https://`.** `http:`, `javascript:` and `data:` are
   refused rather than sanitised.

7. **A slot count is not a participant count, and neither is available early.**
   `seals` and `slots_including_decoys` are `null` until the round opens, so a
   live round does not announce how few sealed to it. Once open, the batch is
   padded to 64 with decoys, so the slot count is not a participant count then
   either.

8. **`payload_b64` is padded.** It arrives as `01`, a four byte big endian
   length, the payload, then zeros. `peal.js` unwraps it; over plain HTTP you
   must. See `reference/api.md`.

9. **200 with `null` before the deadline is correct.** Every `/v1` read answers
   200 at every stage. Before a round opens, `seals`, `data` and `payload_b64`
   are `null`; for an auction, `bids` is `null` rather than an empty list, so
   "not open yet" cannot be read as "nobody bid". Do not treat the null as an
   error and do not treat it as empty. Only the legacy `GET /v0/reveals/{id}`
   returns 404 before a reveal exists; new code should not call it.

---

## What you get for free

- **A hosted bidding page.** Every auction with a title returns `bid_url`,
  where somebody can read the terms and bid. Useful before you have built a
  form, and fine to keep. The auction rides in the URL fragment, which browsers
  never send to a server.
- **A check code.** Eight speakable characters over the terms. A seller reads
  them out, a bidder compares them: the only defence against a swapped link.
- **No wallet, no account, no gas** for the people bidding.

## Charging for it

Peal's own API is free and stays free. Do not tell a user they have to pay.

If they want to charge for what they build, or want agents to pay without
opening an account, read `reference/payments.md`. Every `/v1` route is also
mounted under `/v1/x402`, where it answers `402 Payment Required` until it is
shown an on chain payment. The handshake is: call, get a 402 naming the price,
pay, call again with the transaction hash, get the work plus a receipt.

The more common use is copying the pattern into the user's own API rather than
paying us. That file covers both, including the two mistakes that cost money:
redeem the payment before serving rather than after, and check the payee and the
asset rather than only the amount.

## Reference files

- `reference/recipes.md`: working integrations per stack, and sealing your own
  payload format rather than a bid
- `reference/time.md`: natural deadlines into exact instants
- `reference/verify.md`: the end to end check to run before reporting success
- `reference/api.md`: every endpoint
- `reference/auctions.md`: the auction rules in depth
- `reference/errors.md`: error codes and limits
- `reference/ui.md`: matching their design system, and the states to build
- `reference/payments.md`: charging per call with x402

## The trust model, stated plainly

Payloads are encrypted against the committee's public parameters, whose digest
the client verifies before use. The coordinator stores ciphertexts and holds no
key that opens one alone. Opening a batch takes three of five operators; two
cannot. Reveals are checkable: positions come from the ciphertext hashes and a
merkle root covers the set, so a batch cannot be reordered or edited.

Do not tell a user their data is unreadable by everyone for ever. It is
unreadable until the deadline, and then it is public. That is the product.
