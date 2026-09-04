/** Sealed bid auctions, with the three calls runnable. */
import type { DocsPage } from '../../docs';
import { type Demo, client, demoHtml, wireDemos } from './runner';

const demos: Demo[] = [
  {
    id: 'auction-open',
    title: '1. Open the auction',
    note: `The rules travel with it: the currency and its decimals, an optional reserve and an
           optional maximum. Rules that cannot be satisfied, like a maximum below the reserve,
           are refused here rather than at the close on an auction already running.`,
    code: `const auction = await peal.createAuction({
  title:        'Signed tour poster',
  description:  'One of a kind, ships worldwide.',
  imageUrl:     'https://images.example.com/poster.jpg',

  closesIn:     3600,        // or closesAt: '2026-09-12T18:00:00Z'

  currency:     'USD',       // decimals come with the code
  reserveMinor: 10_00,       // nothing below this can win
  maximumMinor: 500_00,      // nothing above this can win

  tag:          'my-shop',
});

// auction.bid_url is a hosted page bidders can open right away.`,
    run: async (log, state) => {
      const auction = await client.createAuction({
        title: 'Signed tour poster',
        description: 'One of a kind, ships worldwide.',
        closesIn: 70,
        currency: 'USD',
        reserveMinor: 10_00,
        maximumMinor: 500_00,
        tag: 'docs:auction',
      });
      state.auctionId = auction.id;
      state.bidders = 0;
      log(JSON.stringify(auction, null, 2));
      log(`\ncheck code ${auction.check_code ?? 'none'} · read it out, a bidder sees the same one.`);
      log(`closes in about a minute. bid on it in step 2.`);
    },
  },
  {
    id: 'auction-bid',
    title: '2. Place a sealed bid',
    note: `The amount goes into a fixed width record and is encrypted here, so what reaches the
           network is 320 bytes whether the bid is five dollars or five hundred thousand. Run it
           more than once to add bidders: none of them can see the others.`,
    code: `await peal.bid(auction.id, {
  amountMinor: 125_00,       // 125.00 in a 2 decimal currency
  name:        'ana',        // shown on the board, never trusted
});`,
    run: async (log, state) => {
      if (!state.auctionId) {
        log('run step 1 first: this needs an auction to bid on.');
        return;
      }
      const cast = [
        { name: 'ana', amountMinor: 125_00 },
        { name: 'bo', amountMinor: 90_00 },
        { name: 'too low', amountMinor: 5_00 },
        { name: 'joke bid', amountMinor: 999_00 },
      ];
      const next = cast[state.bidders % cast.length]!;
      state.bidders += 1;
      const sealed = await client.bid(state.auctionId, next);
      log(`sealed ${next.name}'s bid of ${(next.amountMinor / 100).toFixed(2)} USD`);
      log(`ct_hash ${sealed.id}`);
      const auction = await client.getAuction(state.auctionId);
      log(`\n${auction.bids} bid${auction.bids === 1 ? '' : 's'} in, and none of them readable.`);
      if (state.bidders < cast.length) log(`run it again to add another bidder.`);
    },
  },
  {
    id: 'auction-results',
    title: '3. Read the board',
    note: `Null until it closes, so "not open yet" can never be read as "no bids". Afterwards:
           every readable bid ranked, the queue the rules allow to win, and anything discarded
           with the reason why.`,
    code: `const { winner, queue, bids, discarded } = await peal.results(auction.id);

// bids     every readable bid, ranked, whether or not it can win
// queue    only the ones inside the reserve and the maximum
// winner   queue[0], or null if nothing qualified`,
    run: async (log, state) => {
      if (!state.auctionId) {
        log('run step 1 first.');
        return;
      }
      const r = await client.results(state.auctionId);
      if (!r.bids) {
        const auction = await client.getAuction(state.auctionId);
        const left = auction.closes_at_unix
          ? auction.closes_at_unix - Math.floor(Date.now() / 1000)
          : null;
        log(`status ${r.status}${left && left > 0 ? `, closes in ${left}s` : ''}.`);
        log(`\nnothing is readable yet. try again once it closes.`);
        return;
      }
      log(`ranked, all ${r.bids.length}:`);
      for (const b of r.bids) {
        const why = [
          !b.meets_reserve ? 'under the reserve' : '',
          !b.within_maximum ? 'over the maximum' : '',
        ].filter(Boolean).join(', ');
        log(`  ${(b.amount_minor / 100).toFixed(2).padStart(9)}  ${(b.name || 'anon').padEnd(10)}${why}`);
      }
      log(`\nqueue    ${(r.queue ?? []).map((b) => b.name || 'anon').join(' → ') || '(nobody qualified)'}`);
      log(`winner   ${r.winner ? `${r.winner.name} at ${(r.winner.amount_minor / 100).toFixed(2)}` : 'none'}`);
      log(`decoys   ${r.decoys} the coordinator added to fill the batch`);
      for (const d of r.discarded ?? []) log(`discarded ${d.ct_hash.slice(0, 12)}… ${d.reason}`);
    },
  },
];

export const auctions: DocsPage = {
  title: 'Sealed bid auctions',
  lede: 'Everything the create page does, as three calls, with the rules that decide what a bid means.',
  html: `
    <h2 id="try-one">Try one</h2>
    <p>Run these in order against the live network. The auction closes about a minute after you
    open it, so you can watch a real one through from an empty board to a result.</p>
    ${demos.map(demoHtml).join('')}

    <h2 id="the-rules">The rules, and why each one is there</h2>
    <p>The rounds API gives you submissions that open together. An auction is that plus the rules
    that decide what a bid <em>means</em>, and those rules are the reason this lives in the API
    rather than being left to every caller to get subtly wrong.</p>
    <ul class="doc-list">
      <li><strong>Amounts are integers of minor units.</strong> <code>12.50</code> in a two
      decimal currency is <code>1250</code>. Money in a float is a rounding error waiting for a
      big enough auction.</li>
      <li><strong>Every bid is the same size on the wire.</strong> The record is padded to 320
      bytes before encryption, so a bid of five and a bid of five hundred thousand are
      indistinguishable until the auction opens. Without this the ciphertext length ranks the
      bids for anyone watching.</li>
      <li><strong>A reserve and a maximum, both optional.</strong> Nothing is escrowed, so a bid
      is cheap talk. The maximum is what stops a joke bid of ninety nine million taking your
      auction.</li>
      <li><strong>The result is a queue, not just a winner.</strong> For the same reason: if the
      top bidder does not pay, the seller works down the list rather than losing the sale.</li>
      <li><strong>Ties break on batch position, which comes from the ciphertext hashes</strong>
      rather than arrival order. So a tie cannot be won by bidding earlier, and the coordinator
      cannot reorder a batch to choose a winner.</li>
      <li><strong>A bid naming a different auction is discarded</strong>, with the reason. A
      ciphertext is not bound to a round, so the same sealed bytes can be replayed into another
      auction; the id inside the record is what makes that detectable.</li>
    </ul>

    <h2 id="a-page-for-bidders">A page bidders can open</h2>
    <p>Every auction with a title comes back with a <code>bid_url</code>: a hosted page where
    somebody reads the terms and places a bid. You do not have to build a bidding interface to
    test this, or ever, if the hosted one suits you.</p>
    <p>The whole auction rides in the URL fragment, the part after the <code>#</code>. Browsers
    never send a fragment to a server, so opening that link tells nobody which auction it is,
    including us.</p>
    <p>Next, the full integration: <a href="#/developers/createauction">creating an auction</a>
    covers the money rules, contact details, the closing time and a checklist before you ship.</p>`,
  mount: (root) => wireDemos(root, demos, { bidders: 0 }),
};
