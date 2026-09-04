# Sealed bid auctions

The rules that decide what a bid means. These live in the API because getting
them wrong is subtle and expensive.

## Opening one

```js
const auction = await peal.createAuction({
  title:        'Signed tour poster',
  description:  'One of a kind, ships worldwide.',
  imageUrl:     'https://images.example.com/poster.jpg',

  closesIn:     3600,          // or closesAt: a Date, ISO string, or unix seconds

  currency:     'USD',         // decimals come with the code
  reserveMinor: 10_00,         // nothing below this can win
  maximumMinor: 500_00,        // nothing above this can win

  tag:          'my-shop',
});
```

`title`, `description` and `image_url` are **public from the moment the auction
exists**. That is the point: somebody deciding what to bid is looking at a name
and a number, and a picture is the difference between a guess and an offer. Do
not put anything sensitive in them.

## The money rules

**Integers of minor units, everywhere, including your own database.** `12.50` in
a two decimal currency is `1250`. A float is a rounding error waiting for an
auction big enough to matter, and there is no arguing with a number that came
out wrong in public.

**Set a maximum.** It is the field people skip and regret. Nothing is escrowed,
so a bid costs nothing to make and somebody can type a number they have no
intention of paying. A maximum bounds that: a joke bid of ninety nine million
cannot take the auction. Pick the most you would believe from a stranger.

**Build for the queue, not the winner.** The result is a queue for the same
reason. If whoever is first does not pay, you work down the list. Retrofitting
that after a non-paying winner is worse than designing for it.

## Bidding

```js
await peal.bid(auction.id, {
  amountMinor: 125_00,
  name:        'ana',          // shown on the board, never trusted, never unique
});
```

The amount goes into a fixed-width record and is encrypted in the bidder's
process. What reaches the network is 320 bytes whether the bid is five dollars
or five hundred thousand. **If you write your own bidder, pad it.** Otherwise
the ciphertext length ranks the auction for anyone watching, before a single bid
opens.

## Reading the board

```js
const { winner, queue, bids, discarded } = await peal.results(auction.id);
```

- `bids` — every readable bid, ranked, whether or not it can win
- `queue` — only those inside the reserve and the maximum, in order
- `winner` — the first of the queue, or null if nothing qualified
- `discarded` — unreadable payloads, or bids naming another auction, with the reason

Before the close, `bids` is `null` rather than an empty list.

Ranking is amount first, then batch position, and position comes from the
ciphertext hashes rather than arrival order. A tie cannot be won by bidding
earlier, and the coordinator cannot reorder a batch to choose a winner.

A bid naming a different auction is discarded. A ciphertext is not bound to a
round, so the same sealed bytes can be replayed into another auction; the
auction id inside the record is what makes that detectable.

## Contact details

Everything in a bid is published when the batch opens, so a plain contact field
would be readable by every other bidder. It has to be encrypted to the seller.

```js
import { generateSellerKeys, sealContact, openContact } from 'https://peal.network/peal.js';

// once, when creating the auction. KEEP THE PRIVATE HALF.
const keys = await generateSellerKeys();
const auction = await peal.createAuction({ contactPublicKey: keys.publicKey, /* … */ });

// the bidder
const sealed = await sealContact(auction.contact_public_key, 'ana@example.com');
await peal.bid(auction.id, { amountMinor: 125_00, name: 'ana', sealedContact: sealed });

// the seller, after the close
const blob = Uint8Array.from(atob(bid.sealed_contact_b64), (c) => c.charCodeAt(0));
const reach = await openContact(keys.privateKey, blob);
```

Never send the private half to the API. The private key is the only copy: lose
it and every contact detail is permanently unreadable by everyone, including the
seller. Anything that let it be recovered would let us read them.

## The link and the check code

Every auction with a title returns:

- `bid_url` — a hosted page where somebody can read the terms and bid. The whole
  auction rides in the URL fragment, which browsers never send to a server, so
  opening it tells nobody which auction it is.
- `check_code` — eight speakable characters over the terms. A seller reads them
  out and a bidder compares them against their own screen. It is the only
  defence against a link that was swapped on the way.
- `terms_hash` — sha256 over the same terms, if you want to anchor them onchain
  yourself.

## Checklist

- amounts are integers of minor units everywhere
- a maximum is set
- your interface can move to the next bidder in the queue
- if you collect contact details, the private key is backed up; there is no recovery
- bidders can see that their bid is unreadable until the close. It is the reason
  they put a real number in
