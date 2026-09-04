# Working integrations

Pick the one that matches the application. Every snippet here has been run.

## The rule that decides the shape

**Sealing happens where the plaintext already is** — normally the browser. The
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
state — a query parameter, `localStorage`, or your existing backend.

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

Only when there is no browser in the flow — a scheduled job, an agent acting on
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
