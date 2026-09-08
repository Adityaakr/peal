/** The create-an-auction guide, at /developers/createauction.
 *
 * Written as markdown so the page and its copy button cannot disagree. Every
 * code block here was run against the live network before it was written down.
 */
import { renderDocs, type DocsPage } from '../docs';
import { API_BASE } from '../api';

export function renderCreateAuctionDocs(root: HTMLElement): () => void {
  const base = API_BASE || window.location.origin;

  const page: DocsPage = {
    title: 'Create an auction',
    lede: 'Sealed bid auctions in your own product: three calls, no wallet for your bidders, and nobody who can read a bid early.',
    markdown: `
## What you are building

A sealed bid auction where every bid is encrypted with batched threshold
encryption (BTE) before it leaves the bidder's device, nothing is readable while
bidding is open, and every bid opens in the same instant when the clock runs
out. No bidder can see another's number, you
cannot see them either, and neither can we.

Your bidders need no wallet, no account and no gas. They need a browser.

> The reveal is not a move anybody has to make. Commit and reveal schemes have
> the same bug everywhere they appear: whoever is losing can simply decline to
> reveal. Here the network opens the batch on its own when the deadline passes.

## Before you start

Nothing to install and no key to get. The client is one file served from this
domain, and the API is plain JSON over HTTP if you would rather call it directly.

\`\`\`js
import { peal } from '${base}/peal.js';
\`\`\`

## 1. Open the auction

The rules travel with the auction. Set them here, where you can still change
them, rather than discovering a problem at the close on something already
running.

\`\`\`js
const auction = await peal.createAuction({
  title:        'Signed tour poster',
  description:  'One of a kind, ships worldwide.',
  imageUrl:     'https://images.example.com/poster.jpg',

  closesIn:     3600,          // or closesAt: '2026-09-12T18:00:00Z'

  currency:     'USD',
  decimals:     2,             // 0 for yen, 3 for a dinar
  reserveMinor: 10_00,         // nothing below this can win
  maximumMinor: 500_00,        // nothing above this can win

  tag:          'my-shop',     // how you list your own auctions later
});
\`\`\`

You get back the auction with its \`id\`, \`closes_at\` and the rules as stored.
Keep the id: it is what your bidders bid on.

### Money is integers, always

Amounts are whole **minor units** of the currency. 12.50 in a two decimal
currency is \`1250\`. Never a float: a float is a rounding error waiting for an
auction big enough to matter, and there is no way to argue with a number that
came out wrong in public.

\`decimals\` tells the API how to read them, and it comes from the currency
rather than from preference. Yen has none. A Kuwaiti dinar has three.

### The currency

Pass a code and the decimals come with it. You do not have to know that the yen
has none and the Kuwaiti dinar has three, and getting it wrong seals a 1250 yen
bid and opens it as 12.50.

\`\`\`js
currency: 'JPY'        // decimals: 0, filled in for you
currency: 'inr'        // stored as INR, decimals: 2
currency: 'points'     // not money at all, decimals: 0
currency: 'credits', decimals: 0    // your own unit, so you say
\`\`\`

The same list the create page offers is an endpoint, so you can build the same
picker rather than hard-coding a dozen codes. It searches by code, name and
symbol, because people type all three.

\`\`\`js
await peal.currencies('rupee');   // INR, PKR, LKR, …
await peal.currencies('¥');       // JPY
await peal.currencies();          // all 56
\`\`\`

### Picking the closing time

\`closesIn\` is seconds from now, which is the easy case. For a real date, use
\`closesAt\`, which takes a \`Date\`, an RFC 3339 string, or unix seconds.

\`\`\`js
// in an hour
closesIn: 3600

// a fixed moment, written in UTC
closesAt: '2026-09-12T18:00:00Z'

// unix seconds, if that is what your database holds
closesAt: 1789408800

// a Date, which is the one to reach for when a human picked the time
closesAt: new Date('2026-09-12T18:00:00Z')
\`\`\`

A seller almost never thinks in UTC. They think "next Friday at six". Build the
\`Date\` in their own timezone and pass it: a \`Date\` carries the offset, so
the conversion happens for you.

\`\`\`js
// tomorrow at 18:00 in whatever timezone this code is running in
const closes = new Date();
closes.setDate(closes.getDate() + 1);
closes.setHours(18, 0, 0, 0);
await peal.createAuction({ closesAt: closes, /* … */ });

// straight from an <input type="datetime-local">, which gives local time
const closes = new Date(form.closesAt.value);   // '2026-09-12T18:00'

// a specific timezone, regardless of where your server runs
const closes = new Date('2026-09-12T18:00:00+05:45');   // Kathmandu
\`\`\`

Three things to know about time here:

- **A bare local string is refused.** \`'2026-09-12T18:00'\` has no offset, so
it means a different instant in every timezone. Pass a \`Date\` or include the
offset. You get \`invalid_time\` rather than a guess.
- **Everything comes back in UTC**, as \`closes_at\`, with \`closes_at_unix\`
beside it for arithmetic. Format it in the reader's timezone when you display it.
- **The time must be in the future.** A deadline in the past is \`opens_in_past\`,
because nothing could ever be sealed to it.

### The reserve and the maximum

Both optional, and the maximum is the one people skip and regret.

Nothing is escrowed here, so a bid costs nothing to make and somebody can type a
number they have no intention of paying. A maximum bounds that: a joke bid of
ninety nine million cannot take your auction. Pick the most you would actually
believe from a stranger.

The reserve is the other end: nothing below it can win.

## 2. Take bids

One call. The amount is encoded into a fixed width record and encrypted in the
bidder's process, so what reaches the network is 320 bytes whether the bid is
five dollars or five hundred thousand.

\`\`\`js
await peal.bid(auction.id, {
  amountMinor: 125_00,       // 125.00
  name:        'ana',        // shown on the board, never trusted, never unique
});
\`\`\`

### Why the fixed width matters

The ciphertext body is a keystream over the plaintext, so a sealed blob's
**length is public** the moment it is submitted. Sealing the digits of a bid
directly would rank the whole auction for anyone watching, before a single bid
opened. Measured against this network: \`5\` sealed to 100 base64 characters and
\`999999999999\` to 116.

The client pads for you. If you build your own bidder, pad to a fixed width or
you have a sealed bid auction where the bids are in order of size.

## 3. Read the board

\`\`\`js
const { winner, queue, bids, discarded } = await peal.results(auction.id);
\`\`\`

Before the close, \`bids\` is \`null\` rather than an empty list, so "not open
yet" can never be read as "nobody bid". Afterwards:

- **bids** every readable bid, ranked, whether or not it can win
- **queue** only the ones inside the reserve and the maximum, in order
- **winner** the first of the queue, or null if nothing qualified
- **discarded** anything unreadable or belonging to another auction, with the reason

### Take the queue seriously

The result is a queue and not just a winner, for the same reason the maximum
exists. Nothing was escrowed, so the top bid is a promise rather than a payment.
If whoever is first does not pay, you work down the list. Build your interface
around that from the start; retrofitting it after a non paying winner is worse.

### Ties

Ranking is amount first, then batch position. Position comes from the ciphertext
hashes rather than the order bids arrived, so a tie cannot be won by bidding
earlier, and we cannot reorder a batch to choose a winner.

## Waiting for the close

Poll the auction, and send the ETag back while you wait. An unchanged poll costs
a 304 instead of a body.

\`\`\`js
const auction = await peal.waitForOpen(auctionId);   // resolves when it closes
const results = await peal.results(auctionId);
\`\`\`

Or from your own server, with plain HTTP:

\`\`\`bash
curl -s ${base}/v1/auctions/AUCTION_ID \\
  -H "if-none-match: $ETAG" -D-
\`\`\`

## The link bidders open

Every auction with a title comes back with a \`bid_url\`: a hosted page where
somebody can read the terms and place a bid. You do not have to build a bidding
interface to test the thing, or ever, if the hosted one suits you.

\`\`\`js
const auction = await peal.createAuction({ /* … */ });
console.log(auction.bid_url);
// https://peal.network/#/live/WzUsImNvbmRfNmRhY2I5…
\`\`\`

The whole auction rides in the **URL fragment**, the part after the \`#\`.
Browsers never send a fragment to a server, so opening that link tells nobody
which auction it is, including us. There is no lookup and no record of who
looked.

It also means the link is self contained and long. If you want a short one:

### Short links

\`peal.network/shoonya\` instead of a hundred and sixty characters. A name is
claimed once in an onchain registry and **never moves**, not even by whoever
claimed it. That is the whole security argument: a name that could be repointed
would mean the person who shared a link is also the person who can change where
it goes.

You can check one from the API:

\`\`\`js
await peal.checkName('shoonya');
// { name: 'shoonya', valid: true, available: false, url: '…', permanent: true }
\`\`\`

Claiming is deliberately **not** something this API does for you. It is a
permanent write that can never be undone, and a name spent is spent, so it
happens from your own key rather than from a server acting on your behalf. The
[create page](#/create) claims one for you if you would rather not write that
code.

## Contact details, if you need them

A bidder can attach a phone number or a handle. Everything in a bid is published
when the batch opens, so a plain contact field would be readable by every other
bidder. It has to be encrypted to you, and the client does the whole thing:

\`\`\`js
import { peal, generateSellerKeys, sealContact, openContact } from '${base}/peal.js';

// once, when you create the auction. KEEP THE PRIVATE HALF.
const keys = await generateSellerKeys();
const auction = await peal.createAuction({
  contactPublicKey: keys.publicKey,
  /* … */
});

// the bidder, encrypting to that key
const sealed = await sealContact(auction.contact_public_key, 'ana@example.com');
await peal.bid(auction.id, { amountMinor: 125_00, name: 'ana', sealedContact: sealed });

// you, after it closes
for (const bid of (await peal.results(auction.id)).bids) {
  if (!bid.sealed_contact_b64) continue;
  const blob = Uint8Array.from(atob(bid.sealed_contact_b64), (c) => c.charCodeAt(0));
  console.log(bid.name, await openContact(keys.privateKey, blob));
}
\`\`\`

Send us the private half and we could read every contact detail sealed to it, so
the API only accepts the public one.

Three details that are doing work: the ephemeral key is per bid, so two bids
from one person are not linkable by anything in the blob; the text is padded to
the cap before encryption, so its length says nothing; and every sealed contact
is 157 bytes, so a bid carrying one is indistinguishable from a bid that does
not. Up to 63 bytes of text.

The cost is real and cannot be engineered away: the private key is the only
copy. Lose it and the contact details are unreadable by everyone, including you.
Anything that let us recover them would let us read them.

## Showing the auction to bidders

\`title\`, \`description\` and \`image_url\` are public from the moment the
auction exists, which is the point: somebody deciding what to bid is looking at
a name and a number, and a picture is the difference between a guess and an
offer.

They come back on the list as well as on a single fetch, so a gallery of your
auctions is one request rather than one per tile.

\`\`\`js
const { data } = await peal.listRounds({ tag: 'my-shop', limit: 20 });
\`\`\`

## Errors

Every failure is problem+json with a stable \`code\` to branch on and a
\`field\` when one input is at fault. \`detail\` is for people and its wording is
not part of the contract.

\`\`\`json
{
  "type":   "https://peal.network/#/developers#invalid_maximum",
  "title":  "invalid request",
  "status": 400,
  "code":   "invalid_maximum",
  "detail": "the maximum cannot be below the reserve",
  "field":  "maximum_minor"
}
\`\`\`

The ones you will meet: \`missing_deadline\`, \`invalid_currency\`,
\`invalid_decimals\`, \`invalid_reserve\`, \`invalid_maximum\`,
\`invalid_ciphertext\`, \`round_closed\` when a bid arrives after the close, and
\`not_found\`.

## Every limit, in one place

Checked on the server, so these are the numbers that actually refuse a request
rather than a summary of them.

### Creating an auction

- \`title\` up to **120 characters**
- \`description\` up to **2000 characters**
- \`imageUrl\` up to **500 characters**, \`https://\` only, no whitespace
- \`tag\` up to **32 characters** of \`a-z 0-9 : _ -\`
- \`currency\` **1 to 12 characters**; a known code fills in \`decimals\`
- \`decimals\` **0 to 4**, only needed for a code the table does not know
- \`name\` for a short link: **3 to 32 characters** of \`a-z 0-9 -\`, not
starting or ending with a hyphen
- \`reserveMinor\` and \`maximumMinor\` **0 to 1,000,000,000,000** minor units,
and the maximum may not be below the reserve
- \`closesAt\` must be in the future; \`closesIn\` must be positive
- \`Idempotency-Key\` up to **200 characters**, remembered for **24 hours**

### Bidding

- \`amountMinor\` **1 to 1,000,000,000,000**, a whole number
- \`name\` up to **48 bytes** of UTF-8. Bytes, not characters: an emoji is four,
so twelve of them is the limit
- \`sealedContact\` up to **157 bytes**, which is what the contact scheme
produces
- every bid is **320 bytes** before encryption, whatever is in it
- a raw seal outside an auction is padded to **256, 1024, 4096, 16384 or 65536
bytes**, and capped at **5 MB**

### Reading

- \`limit\` **1 to 200**, default **25**
- rate limit **50 requests a second**, bursting to **400**, per IP. Every
response carries \`RateLimit-Remaining\`, so you never have to be refused to
find out
- batches are **64 slots**; a smaller auction is padded with decoys, so the slot
count is never the number of bidders

### What happens at each limit

Nothing is truncated silently. Over a limit is a \`400\` with a \`code\` and
the \`field\` at fault, so you can put the message next to the right input.

## A checklist before you ship

- Amounts are integers of minor units everywhere, including in your database.
- A maximum is set. Without one a single joke bid can take an auction.
- Your interface can move to the next bidder in the queue.
- If you collect contact details, the private key is backed up somewhere you
  trust, because there is no recovery.
- You show bidders that their bid is unreadable until the close. It is the
  reason they are willing to put a real number in.

## What is still yours to build

The API decides what a bid means and who is ahead. It does not take payment,
does not ship anything, and does not know whether the winner paid. Those are
yours, and they are the parts where your product differs from everybody else's.

Currency conversion for bidders thinking in another currency is client side for
now: convert before you call \`bid\`, and keep what they typed for your records.
`.trim(),
  };

  return renderDocs(root, page, '#/developers/createauction');
}
