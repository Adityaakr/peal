# Working integrations

Pick the one that matches the application. Every snippet here has been run.

## The rule that decides the shape

**Sealing happens where the plaintext already is**, normally the browser. The
whole point is that a bid never reaches a server in the clear, including the
seller's own. Server code creates auctions and reads results.

`import { peal } from 'https://peal.network/peal.js'` works **in browsers
only**. Node throws `ERR_UNSUPPORTED_ESM_URL_SCHEME`. On a server use plain
`fetch`, or vendor the file:

```bash
curl -fsSL -o lib/peal.js https://peal.network/peal.js
```

---

## Next.js (App Router)

### 1. Store the auction id against your listing

```prisma
model Listing {
  id             String    @id @default(cuid())
  title          String
  pealAuctionId  String?   // the Peal auction, once one is open
  auctionEndsAt  DateTime?
}
```

### 2. A route handler that opens the auction

```ts
// app/api/listings/[id]/auction/route.ts
import { NextResponse } from 'next/server';

const PEAL = 'https://peal.network';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const { closesAt, reserve, currency = 'USD' } = await req.json();
  const listing = await db.listing.findUnique({ where: { id: params.id } });
  if (!listing) return NextResponse.json({ error: 'no such listing' }, { status: 404 });

  const res = await fetch(`${PEAL}/v1/auctions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Retry safe: a timeout will not create a second auction.
      'idempotency-key': `listing-${listing.id}`,
    },
    body: JSON.stringify({
      title: listing.title,
      description: listing.description,
      image_url: listing.imageUrl,          // https only
      closes_at: closesAt,                  // ISO with an offset
      currency,                             // decimals come with the code
      reserve_minor: reserve,               // INTEGER minor units
      tag: 'my-marketplace',
    }),
  });

  const auction = await res.json();
  if (!res.ok) {
    // problem+json: branch on code, show detail, point at field.
    return NextResponse.json({ error: auction.code, detail: auction.detail }, { status: 400 });
  }

  await db.listing.update({
    where: { id: listing.id },
    data: { pealAuctionId: auction.id, auctionEndsAt: new Date(auction.closes_at) },
  });

  return NextResponse.json({ auctionId: auction.id, bidUrl: auction.bid_url });
}
```

### 3. The bid form, in the browser

The markup below is deliberately bare: it shows the sealing, the states and the
error handling, and nothing about how it should look. Do not ship it like this.
`reference/ui.md` is how you find what the app is built out of and rebuild this
form from their own components, which takes about three file reads.

```tsx
'use client';
import { useState } from 'react';

export function BidForm({ auctionId }: { auctionId: string }) {
  const [amount, setAmount] = useState('');
  const [state, setState] = useState<'idle' | 'sealing' | 'sealed' | string>('idle');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('sealing');
    try {
      const { peal } = await import('https://peal.network/peal.js');
      // Minor units: 12.50 becomes 1250. Never a float.
      const amountMinor = Math.round(parseFloat(amount) * 100);
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new Error('enter an amount');
      await peal.bid(auctionId, { amountMinor, name: 'anon' });
      setState('sealed');
    } catch (err) {
      setState(err instanceof Error ? err.message : 'that did not go through');
    }
  }

  if (state === 'sealed') {
    return <p>Your bid is sealed. Nobody can read it, including us, until the auction closes.</p>;
  }
  return (
    <form onSubmit={submit}>
      <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      <button disabled={state === 'sealing'}>{state === 'sealing' ? 'sealing…' : 'place sealed bid'}</button>
      {typeof state === 'string' && !['idle', 'sealing'].includes(state) && <p role="alert">{state}</p>}
    </form>
  );
}
```

A dynamic `import()` keeps the 500KB client off the initial bundle: it loads
when somebody actually bids.

### 4. Show the result after the close

```ts
const res = await fetch(`${PEAL}/v1/auctions/${listing.pealAuctionId}/results`);
const { status, winner, queue, bids } = await res.json();

if (!bids) {
  // Still open. `bids` is null rather than [], so this is not "nobody bid".
  return { open: true };
}
return { winner, runnersUp: queue.slice(1) };
```

---

## Express / plain Node

```js
import express from 'express';
const PEAL = 'https://peal.network';
const app = express();
app.use(express.json());

app.post('/listings/:id/auction', async (req, res) => {
  const listing = await db.getListing(req.params.id);

  const r = await fetch(`${PEAL}/v1/auctions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `listing-${listing.id}` },
    body: JSON.stringify({
      title: listing.title,
      closes_at: req.body.closesAt,
      currency: 'USD',
      reserve_minor: req.body.reserveMinor,
      maximum_minor: req.body.maximumMinor,
      tag: 'my-app',
    }),
  });
  const auction = await r.json();
  if (!r.ok) return res.status(400).json({ error: auction.code, detail: auction.detail });

  await db.setAuctionId(listing.id, auction.id);
  res.json({ auctionId: auction.id, bidUrl: auction.bid_url, checkCode: auction.check_code });
});

app.get('/listings/:id/results', async (req, res) => {
  const listing = await db.getListing(req.params.id);
  const r = await fetch(`${PEAL}/v1/auctions/${listing.pealAuctionId}/results`);
  res.json(await r.json());
});
```

No client library on the server at all. Bids are sealed in the browser.

---

## A static page, no server

Everything in the browser. Keep the auction id wherever the page already keeps
state: a query parameter, `localStorage`, or your existing backend.

```html
<script type="module">
  import { peal } from 'https://peal.network/peal.js';

  document.querySelector('#open').addEventListener('click', async () => {
    const auction = await peal.createAuction({
      title: 'Vintage camera',
      closesAt: new Date('2026-09-08T17:00:00Z'),
      currency: 'USD',
      reserveMinor: 50_00,
      tag: 'my-shop',
    });
    localStorage.setItem('auction', auction.id);
    // A page bidders can open, with no interface of your own.
    window.location = auction.bid_url;
  });

  document.querySelector('#bid').addEventListener('click', async () => {
    const id = localStorage.getItem('auction');
    await peal.bid(id, { amountMinor: 125_00, name: 'ana' });
  });
</script>
```

---

## Python, Ruby, Go, anything else

Create and read over HTTP; seal in the browser.

```python
import requests

PEAL = "https://peal.network"

def open_auction(listing, closes_at_iso):
    r = requests.post(
        f"{PEAL}/v1/auctions",
        headers={"idempotency-key": f"listing-{listing.id}"},
        json={
            "title": listing.title,
            "closes_at": closes_at_iso,   # RFC 3339 with an offset
            "currency": "USD",
            "reserve_minor": 50_00,       # integer minor units
            "tag": "my-app",
        },
        timeout=15,
    )
    body = r.json()
    if not r.ok:
        raise ValueError(f"{body['code']}: {body['detail']}")
    listing.peal_auction_id = body["id"]
    listing.save()
    return body

def results(listing):
    r = requests.get(f"{PEAL}/v1/auctions/{listing.peal_auction_id}/results", timeout=15)
    return r.json()
```

For sealing, render the bid form with `peal.js` and pass the auction id into the
page. There is no supported way to seal from Python today, and doing it by
sending a plaintext to the server would defeat the entire mechanism.

---

## Sealing on a Node server, when you really must

Only when there is no browser in the flow: a scheduled job, an agent acting on
its own behalf. Vendor the file; URL imports do not work in Node.

```bash
curl -fsSL -o lib/peal.js https://peal.network/peal.js
```

```js
import { Peal } from './lib/peal.js';

const peal = new Peal({ url: 'https://peal.network' });
await peal.bid(auctionId, { amountMinor: 125_00, name: 'scheduler' });
```

Pin it by committing the file: it is one dependency-free module, and vendoring
means a network blip cannot break your build.

---

## Your own payload, not a bid

`peal.bid()` is one payload format with rules already written for it. When you
are sealing something else, a vote, an offer, a model output, a set of numbers
to reconcile, you write the format and you write the rules. There are four
moves, and the auction record is the worked example of all four.

**Watch the argument order.** It is not the same as `bid`:

```js
await peal.bid(roundId, { amountMinor: 125_00 });   // id first
await peal.seal(payload, roundId, { padTo: 133 });  // payload FIRST, then id
```

`payload` is a string or a `Uint8Array`. `seal` returns the `Seal`, whose `id`
is the SHA-256 of the ciphertext, so you can compute it yourself rather than
trusting the answer about which seal is yours.

### 1. Give the record a schema, starting with a version byte

A round holds bytes. Nothing tells a reader what they are, and once you have
shipped one format you will want a second.

```js
const V1 = 1;
const RECORD_BYTES = 128;
const enc = new TextEncoder(), dec = new TextDecoder();

function encodeVote(roundId, choice, weight) {
  const id = enc.encode(roundId), ch = enc.encode(choice);
  if (10 + id.length + 1 + ch.length > RECORD_BYTES) throw new Error('too large');
  const out = new Uint8Array(RECORD_BYTES);
  const view = new DataView(out.buffer);
  out[0] = V1;                                   // version
  view.setBigUint64(1, BigInt(weight), false);   // the secret number
  out[9] = id.length; out.set(id, 10);           // the round it is for
  out[10 + id.length] = ch.length;
  out.set(ch, 11 + id.length);
  return out;
}
```

### 2. Make it a fixed width, then pad to a fixed width

Two different things, and you want both.

The ciphertext body is a keystream over the plaintext, so **a sealed length is
public the moment it is submitted**. `JSON.stringify({choice, weight})` is
shorter for `3` than for `1100`, which puts the magnitude on the wire before
anything opens. Build a fixed-width record, exactly as the auction does.

Then `peal.js` wraps what you hand it in a 5 byte envelope and pads that up to
the next bucket of 256, 1024, 4096, 16384 or 65536. Automatic padding is a
floor, not a plan: two callers whose records land in different buckets are
still distinguishable. Ask for the width instead:

```js
await peal.seal(encodeVote(round.id, 'ship', 11), round.id, {
  padTo: RECORD_BYTES + 5,   // your record, plus the 5 byte envelope
});
```

`padTo` smaller than `payload.length + 5` throws `pad_too_small` rather than
truncating. Every seal in your round must use the same number, or the width you
chose is the thing that leaks.

### 3. Put the round id inside the record

A ciphertext is not bound to the round it was posted to. The same blob replayed
into a second round decrypts to the same bytes, and anyone can post to a public
round. The id inside the record is what makes that detectable, which is why the
auction record carries `auction_id` and why a bid naming another auction is
thrown away.

### 4. Discard on open, do not assume

The payloads that come back are not only yours. Drop anything that does not
parse and anything naming a different round, then read what is left:

```js
await peal.waitForOpen(round.id);

const tally = {};
for (const bytes of await peal.getPayloads(round.id)) {
  const v = decodeVote(bytes);
  if (!v) continue;                     // not our format
  if (v.roundId !== round.id) continue; // replayed from another round
  tally[v.choice] = (tally[v.choice] ?? 0) + v.weight;
}
```

```js
function decodeVote(bytes) {
  if (bytes.length !== RECORD_BYTES || bytes[0] !== V1) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLen = bytes[9];
  const chLen = bytes[10 + idLen];
  return {
    weight: Number(view.getBigUint64(1, false)),
    roundId: dec.decode(bytes.subarray(10, 10 + idLen)),
    choice: dec.decode(bytes.subarray(11 + idLen, 11 + idLen + chLen)),
  };
}
```

`getPayloads()` hands back bytes in batch order with decoys already removed,
and nothing else. If you need the seal id or the batch position, which is what
you check a proof against, use `listSeals()` and unpad yourself:

```js
const seals = await peal.listSeals(round.id);   // id, position, payload_b64
```

### The whole thing, run against the live network

```js
import { peal } from 'https://peal.network/peal.js';

const round = await peal.createRound({ opensIn: 60, tag: 'my-app' });
for (const [choice, weight] of [['keep', 3], ['ship', 11], ['ship', 2]]) {
  await peal.seal(encodeVote(round.id, choice, weight), round.id, {
    padTo: RECORD_BYTES + 5,
  });
}
await peal.waitForOpen(round.id);
// tally, after discarding: { keep: 3, ship: 13 }
```

### Sealing until a moment, with no round to manage

One payload, one deadline, one call. Same padding, same `padTo`:

```js
const { round_id, unlock_at, proof_url } = await peal.sealUntil(
  encodeVote('self', 'ship', 11),
  new Date('2026-09-12T18:00:00+05:30'),
  { tag: 'my-app', padTo: RECORD_BYTES + 5 },
);
```

Use `peal.encrypt(payload, { padTo })` if you want the ciphertext back and will
send it through your own transport.
