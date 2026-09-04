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

A sealed bid auction where every bid is encrypted before it leaves the bidder's
device, nothing is readable while bidding is open, and every bid opens in the
same instant when the clock runs out. No bidder can see another's number, you
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

## Contact details, if you need them

A bidder can attach a phone number or a handle. Everything in a bid is published
when the batch opens, so a plain contact field would be readable by every other
bidder. It has to be encrypted to you.

1. Generate a keypair in your own application.
2. Pass the **public** half as \`contactPublicKey\` when you create the auction.
3. Bidders encrypt to it and pass the result as \`sealedContact\`.
4. You decrypt with the private half after the close.

Send us the private half and we could read every contact detail sealed to it, so
the API only accepts the public one.

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
