// SealBid: the landing page for sealed-bid auctions.
//
// Modelled on mempool-landing.ts, and it borrows that page's structural CSS
// (.ml-section, .ml-scard, .ml-ledger, .ml-chip-*) rather than cloning 200
// lines of near-identical rules. Only what is genuinely new to this page gets
// an .sl- prefix: the split-book stage and the before/now cards.
//
// One editorial rule governs every claim below, and it is not decoration:
// **the page may only say what the deployed contracts and the live pages
// actually do today.** Bids are sealed in the browser to the committee with
// batched threshold encryption (auction.ts calls the SDK's seal and registers
// the real ciphertext hash; decisions/0005). What is still marked build is
// what is still build: the committee is a testnet prop with derivable keys,
// and the reveal root is attested by committee signatures rather than verified
// onchain (decisions/0003 is the scheduled replacement). Claiming more than
// that would be the one lie that costs the product its credibility with the
// exact reader it wants.
import { mountScrollReveal } from '../reveal';
import { ACTIVE, ACTIVE_DEMO } from 'peal-auctionkit';

type Cleanup = () => void;

const reduced = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

type Row = { label: string; value: string; tone?: 'bad' | 'good' | 'link' };
type Step = {
  n: string;
  danger?: boolean;
  title: string;
  chip: string;
  chipTone?: 'red' | 'blue' | 'green';
  body: string;
  rows: Row[];
  visual: string;
};

function ledgerRow(r: Row): string {
  const tone = r.tone ? ` ml-lrow-${r.tone}` : '';
  return `<div class="ml-lrow"><span class="ml-lrow-label">${r.label}</span><span class="ml-lrow-value${tone}">${r.value}</span></div>`;
}

function stepCard(s: Step): string {
  const tone = s.chipTone || (s.danger ? 'red' : 'blue');
  return `<div class="ml-scard">
    <span class="ml-scard-num${s.danger ? ' ml-scard-num-danger' : ''}">${s.n}</span>
    <div class="ml-scard-body${s.danger ? ' ml-scard-body-danger' : ''}">
      <div class="ml-scard-visual">${s.visual}</div>
      <div class="ml-scard-main">
        <div class="ml-scard-head"><h3 class="ml-scard-title">${s.title}</h3><span class="ml-scard-chip ml-chip-${tone}">${s.chip}</span></div>
        <p class="ml-scard-copy">${s.body}</p>
        <div class="ml-ledger">${s.rows.map(ledgerRow).join('')}</div>
      </div>
    </div>
  </div>`;
}

/** A bid as an open book shows it: fully legible, and therefore copyable.
 * Reuses .ml-pub-card so an open bid reads in the same visual language as an
 * unencrypted transaction does on the mempool landing. */
function openBid(qty: string, price: string, top = false): string {
  return `<div class="ml-pub-card sl-obid${top ? ' sl-obid-victim' : ''}">
    <div class="ml-pub-top"><span class="ml-strong">${qty}</span><span class="ml-arrow">at</span><span class="ml-strong sl-obid-price">${price} ${ACTIVE.tokens.quoteSymbol}</span></div>
    <div class="ml-pub-meta">${top ? 'top of book, and everyone can see it' : 'readable the moment it lands'}</div>
    ${top ? '<span class="sl-outbid">outbid</span>' : ''}
  </div>`;
}

/** The bot's reply. Hidden until the snipe beat, then it slides in above the
 * bid it just read. Same shape as .ml-bot on the mempool landing, because it
 * is the same actor doing the same thing. */
function sniperCard(): string {
  return `<div class="ml-bot sl-sniper">
    <span class="mono">bot 0xee…42</span>
    <span class="ml-strong">450,001 at 1.75, one tick above</span>
  </div>`;
}

/** The same bid as a commitment: an object you can count but not read.
 * `open` is what it turns out to have contained, shown only after the reveal
 * beat so the page demonstrates the order that actually happens. */
function sealedBid(hash: string, escrow: string, qty: string, price: string): string {
  return `<div class="ml-sealed sl-sbid">
    <div class="ml-sealed-top">
      <span class="mono ml-hdr">&#x2B21; <b>${hash}</b></span>
    </div>
    <div class="ml-sealed-env mono">
      <span>escrow ${escrow}</span>
      <span class="sl-sbid-q"><span class="sl-q-sealed">quantity ?</span><span class="sl-q-open">${qty}</span></span>
      <span class="sl-sbid-p"><span class="sl-q-sealed">price ?</span><span class="sl-q-open">${price} ${ACTIVE.tokens.quoteSymbol}</span></span>
    </div>
  </div>`;
}

const USE_CASES: { title: string; before: string; now: string; chip?: string }[] = [
  {
    title: 'onchain name auctions',
    before:
      'ENS ran a real sealed-bid auction in 2017. it took two transactions, commit and then reveal. bidders who lost their salt or missed the reveal window forfeited their deposit, and the mechanism was retired.',
    now: 'the bid is sealed to a committee that opens it at the close, and the reveal is driven against a signed root, not by the bidder coming back. one sealed commit is the bidder’s whole job, and there is no salt to lose.',
  },
  {
    title: 'token launches',
    before:
      'a fixed-price sale is a gas race that resolves in one block, decided by whoever pays most for priority. a descending auction rewards waiting, so the price you discover is the price of patience.',
    now: 'everyone names a maximum privately. everyone who wins pays the same clearing price. submitting early costs nothing and submitting late gains nothing.',
  },
  {
    title: 'nft primary sales',
    before:
      'an english auction ends in a sniping war, and every visible bid tells the next bidder where the ceiling is. a seller who can read the book can also bid against their own lot.',
    now: 'no bid informs another bid. the seller learns the clearing price, and learns it after it has already settled.',
  },
  {
    title: 'tokenized treasuries and private credit',
    before:
      'allocations are decided by an arranger in a spreadsheet. you submit a size and a yield, you get a fill, and you cannot check that a larger account was not treated better.',
    now: 'the allocation rule is a contract. pro rata at the clearing tick, computed onchain from the revealed book, applied identically to every bidder and checkable afterwards.',
  },
  {
    title: 'dao treasury block sales',
    before:
      'a dao announces a sale in a public forum. the market prices the supply in over three weeks, and the treasury sells into the hole the announcement dug.',
    now: 'buyers commit against a fixed size and a fixed window. the market learns the price once, at settlement.',
  },
];

function useCaseCard(c: (typeof USE_CASES)[number]): string {
  return `<article class="sl-case">
    <div class="sl-case-head">
      <h3 class="sl-case-title">${c.title}</h3>
      ${c.chip ? `<span class="ml-chip ml-chip-build">${c.chip}</span>` : ''}
    </div>
    <div class="sl-case-split">
      <div class="sl-case-col sl-case-before">
        <span class="sl-case-label">before</span>
        <p>${c.before}</p>
      </div>
      <div class="sl-case-col sl-case-now">
        <span class="sl-case-label">now</span>
        <p>${c.now}</p>
      </div>
    </div>
  </article>`;
}

export function renderSealbidLanding(root: HTMLElement): Cleanup {
  const prevTitle = document.title;
  document.title = 'SealBid. sealed-bid auctions on Peal';

  root.innerHTML = `
<div class="ml sl">
  <section class="ml-hero">
    <p class="ml-kicker scroll-reveal">sealbid</p>
    <h1 class="ml-h1 scroll-reveal">the auctioneer bids blind.</h1>
    <div class="sl-pitch scroll-reveal">
      <p class="sl-pitch-problem">
        <span class="sl-pitch-label">the problem</span>
        an open book publishes your quantity and your price the moment you bid. the last bidder reads it
        and only has to beat it by one tick, so bidding early is strictly worse and the sale discovers its
        price in the final block.
      </p>
      <p class="sl-pitch-solution">
        <span class="sl-pitch-label">what sealbid does</span>
        every bid is a commitment onchain. the seller cannot read the quantity or the price inside it, and
        neither can another bidder. at close the whole book opens at once and settles at one price.
      </p>
    </div>
    <div class="ml-hero-ctas scroll-reveal">
      <a class="ml-btn ml-btn-dark" href="#/sealed-bid-auction">open the live auction</a>
      <a class="ml-btn" href="${ACTIVE.explorer}/address/${ACTIVE_DEMO?.auction ?? ACTIVE.factory}" target="_blank" rel="noopener">see it onchain</a>
    </div>

    <div class="ml-stage scroll-reveal" id="sl-stage">
      <div class="ml-col ml-col-public">
        <div class="ml-col-head"><span class="ml-col-title">open book &middot; today</span><span class="ml-col-note">every bid readable</span></div>
        ${sniperCard()}
        ${openBid('450,000', '1.70', true)}
        ${openBid('300,000', '2.20')}
        ${openBid('260,000', '1.20')}
        <div class="ml-micro">
          <span class="sl-m-rest">the last bidder reads all of it, and beats it by one tick</span>
          <span class="sl-m-snipe">read, then beaten by 0.05</span>
        </div>
      </div>
      <div class="ml-col ml-col-peal">
        <div class="ml-col-head">
          <span class="ml-col-title">sealed book</span>
          <span class="ml-col-note">
            <span class="sl-m-rest">commitments only</span>
            <span class="sl-m-open">opened together</span>
          </span>
        </div>
        ${sealedBid('0xca75e985…e0a436', '336,000', '120,000', '2.80')}
        ${sealedBid('0x03934b44…921716', '660,000', '300,000', '2.20')}
        ${sealedBid('0x6e6c7151…b88828', '765,000', '450,000', '1.70')}
        <div class="sl-clearbar"><span>clearing price</span><b>1.70 ${ACTIVE.tokens.quoteSymbol}</b><span>everyone pays it</span></div>
        <div class="ml-micro">
          <span class="sl-m-rest">nothing to beat by one tick, because there is nothing to read</span>
          <span class="sl-m-open">no bid was ever readable before the close</span>
        </div>
      </div>
    </div>

    <p class="ml-thesis scroll-reveal">the sniper is not slower. <b>it is blind.</b></p>
  </section>

  <section class="ml-section">
    <div class="ml-wrap ml-stats scroll-reveal">
      <div class="ml-stat"><div class="ml-stat-big">1<sup>1</sup></div><div class="ml-stat-small">transaction to bid. classic commit-reveal needs a second one from the bidder</div></div>
      <div class="ml-stat"><div class="ml-stat-big">1<sup>2</sup></div><div class="ml-stat-small">price every winner pays, computed onchain from the revealed book</div></div>
      <div class="ml-stat"><div class="ml-stat-big">3 of 5<sup>3</sup></div><div class="ml-stat-small">committee signatures needed before any bid opens</div></div>
    </div>
    <p class="ml-wrap ml-foot scroll-reveal">
      ¹ commit only, <code>SealedBidAuction.commitBid</code> &middot;
      ² uniform clearing price, <code>ClearingPrice.findClearingTick</code> &middot;
      ³ the demo committee's keys are published on purpose, see honest limits below
    </p>
  </section>

  <section class="ml-section">
    <div class="ml-storywrap scroll-reveal">
      <p class="ml-sec-kicker">the problem</p>
      <h2 class="ml-h2">how an open book takes your money</h2>
      ${[
        {
          n: '1',
          danger: true,
          title: 'your bid is legible',
          chip: 'exposed',
          body: 'an open order book publishes your quantity and your price the moment you submit. anyone deciding what to bid can read what you already bid.',
          rows: [
            { label: 'what you submitted', value: '450,000 at 1.70' },
            { label: 'who can read it', value: 'everyone, immediately', tone: 'bad' as const },
          ],
          visual: openBid('450,000', '1.70', true),
        },
        {
          n: '2',
          danger: true,
          title: 'the last block decides',
          chip: 'sniped',
          body: 'when the book is readable, the winning move is to wait and submit one tick above the top bid in the final block. bidding early is strictly worse, so nobody does it.',
          rows: [
            { label: 'your bid', value: '1.70' },
            { label: 'their bid, one block later', value: '1.75', tone: 'bad' as const },
          ],
          visual: openBid('450,001', '1.75', true),
        },
        {
          n: '3',
          danger: true,
          title: 'the seller learns your ceiling',
          chip: 'shaded',
          body: 'a seller who can read the book learns what each bidder would have paid. knowing that, bidders shade their bids down, and the auction discovers a worse price for everyone.',
          rows: [
            { label: 'what you would pay', value: '2.20' },
            { label: 'what you bid instead', value: '1.70', tone: 'bad' as const },
          ],
          visual: openBid('300,000', '2.20'),
        },
      ]
        .map(stepCard)
        .join('')}
    </div>
  </section>

  <section class="ml-section">
    <div class="ml-storywrap scroll-reveal">
      <p class="ml-sec-kicker">the mechanism</p>
      <h2 class="ml-h2">how sealbid closes the book</h2>
      ${[
        {
          n: '1',
          title: 'seal, do not disclose',
          chip: 'sealed',
          body: 'the bidder encrypts their quantity, their price and a random salt to the committee in their own browser with batched threshold encryption, and posts a commitment to the same values beside the ciphertext hash. nothing readable leaves their machine, and nothing has to be kept: the salt travels inside the ciphertext.',
          rows: [
            { label: 'onchain', value: 'a commitment and a ciphertext hash' },
            { label: 'quantity and price', value: 'not published', tone: 'good' as const },
          ],
          visual: sealedBid('0xca75e985…e0a436', '336,000', '120,000', '2.80'),
        },
        {
          n: '2',
          title: 'escrow is a product, not a price',
          chip: 'bounded',
          body: 'the bidder locks quantity times their maximum price. that amount is a visible token transfer, so the size of a bid is public. the split between quantity and price is not.',
          rows: [
            { label: 'visible', value: 'the escrow amount', tone: 'bad' as const },
            { label: 'not published', value: 'how it splits' },
          ],
          visual: `<div class="sl-escrow">765,000 <span>${ACTIVE.tokens.quoteSymbol}</span></div>`,
        },
        {
          n: '3',
          title: 'one reveal, all at once',
          chip: 't of n',
          body: 'at close the operators each publish a decryption share, and a threshold of them opens the whole batch at once. nobody sends a reveal transaction. the committee then signs one root covering every bid; each revealed bid is checked against the commitment its bidder posted before the close, and the root has to cover the exact number of bids that were committed.',
          rows: [
            { label: 'partial reveals', value: 'refused' },
            { label: 'a missing bid', value: 'halts settlement', tone: 'good' as const },
          ],
          visual: `<div class="sl-root">reveal root</div>`,
        },
        {
          n: '4',
          title: 'one price for everyone',
          chip: 'verifiable',
          chipTone: 'green' as const,
          body: 'demand is bucketed by tick and scanned from the top until it meets supply. everyone above the clearing tick fills in full, everyone at it fills pro rata, and every winner pays the same price.',
          rows: [
            { label: 'winners pay', value: 'the clearing price' },
            { label: 'allocation order', value: 'does not matter', tone: 'good' as const },
          ],
          visual: `<div class="sl-clearing">clearing tick</div>`,
        },
      ]
        .map(stepCard)
        .join('')}
    </div>
  </section>

  <section class="ml-section">
    <div class="ml-wrap scroll-reveal">
      <p class="ml-sec-kicker">use cases</p>
      <h2 class="ml-h2">before, and now</h2>
      <p class="ml-sub sl-cases-sub">five markets that run sealed-bid auctions off-chain, or run the wrong auction onchain because the right one was not available.</p>
      <div class="sl-cases">${USE_CASES.map(useCaseCard).join('')}</div>
    </div>
  </section>

  <section class="ml-section">
    <div class="ml-wrap scroll-reveal">
      <p class="ml-sec-kicker">the research</p>
      <h2 class="ml-h2">the cryptography is not ours</h2>
      <p class="ml-sub sl-cases-sub">
        batched threshold encryption is a construction by the commonware team. we did not invent it,
        we did not reimplement it, and we do not modify it. peal is what it takes to run it in production.
      </p>

      <div class="sl-research">
        <div class="sl-research-col">
          <span class="sl-case-label">from commonware</span>
          <ul class="sl-list">
            <li>the scheme itself, from <b>"batched threshold encryption: a simple construction"</b>, guru vamsi policharla, iacr eprint 2026/760.</li>
            <li>every pairing operation, every group fft, and the fujisaki-okamoto transform, in <code>simple-bte</code>, used unmodified as a dependency and pinned to one commit.</li>
            <li>thresholdization, built into <code>crs::setup</code>. we planned a shamir fallback and did not need it.</li>
          </ul>
        </div>
        <div class="sl-research-col">
          <span class="sl-case-label">what peal adds</span>
          <ul class="sl-list">
            <li>wire formats with version tags and golden-file tests, so a byte that changes shape fails a test rather than a decryption.</li>
            <li>payload caps, per-slot validity, and an api shaped for a coordinator, an operator node, and a browser sdk.</li>
            <li>the rand version is re-exported from one place, so two crates can never disagree about which rng trait they are using.</li>
            <li>a ceremony, a committee, a batching engine, and reveal plumbing. none of that is cryptography, and all of it is why the cryptography can be used by an application.</li>
          </ul>
        </div>
      </div>

      <p class="ml-foot">
        one crate touches group elements. every deviation from the upstream api is written down in
        <code>spec/DEVIATIONS.md</code> with the reason, and every call is mapped function by function in
        <code>spec/API-MAP.md</code>. where we adapt an api we say so, and we say that it is adaptation
        rather than a change to the scheme.
      </p>
    </div>
  </section>

  <section class="ml-section">
    <div class="ml-wrap scroll-reveal">
      <p class="ml-sec-kicker">what comes next</p>
      <h2 class="ml-h2">a faster acknowledgement, without moving the money</h2>
      <p class="ml-sub sl-cases-sub">
        bidding today is two transactions on a twelve second chain, and the wait is real even though
        nothing about the auction depends on it. vara.eth offers a way to shorten the part a person
        actually feels.
      </p>

      <div class="sl-limits">
        <div class="sl-limit">
          <span class="ml-chip ml-chip-build">build</span>
          <p><b>an injected transaction answers before the block does.</b> the wallet signs, the write goes
          straight to vara.eth, and the app gets a promise and a reply it can render immediately. the bidder
          sees their bid land instead of watching a spinner for a slot.</p>
        </div>
        <div class="sl-limit">
          <span class="ml-chip ml-chip-live">live</span>
          <p><b>vara.eth settles to ethereum, not to tempo.</b> so this would be something added
          beside the auction rather than a move, and the contracts stay where they are.</p>
        </div>
        <div class="sl-limit">
          <span class="ml-chip ml-chip-live">live</span>
          <p><b>escrow stays in solidity.</b> that is gear's own recommended pattern for anything holding
          value: funds stay in the ethereum contract and a callback confirms release or refund. the
          auction's money never sits behind a different validator set.</p>
        </div>
        <div class="sl-limit">
          <span class="ml-chip ml-chip-build">build</span>
          <p><b>an early answer is not finality, and we will label it that way.</b> a promise ahead of
          settlement is a soft commitment from vara.eth's validators, currently three of four keys operated
          by one company. showing "committed" on a soft promise, for a transaction carrying escrow, is worse
          than an honest wait. so a preconfirmed bid will read as preconfirmed until it settles.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="ml-section">
    <div class="ml-wrap scroll-reveal">
      <p class="ml-sec-kicker">honest limits</p>
      <h2 class="ml-h2">what this does not do</h2>
      <div class="sl-limits">
        <div class="sl-limit">
          <span class="ml-chip ml-chip-live">live</span>
          <p><b>the split is hidden, the size is not.</b> escrow is a token transfer of quantity times max price. prices are a ladder of at most 256 ticks, so anyone who tries can usually narrow the split to a few candidates. this is not bid size privacy and sealbid does not claim it.</p>
        </div>
        <div class="sl-limit">
          <span class="ml-chip ml-chip-live">live</span>
          <p><b>bids are threshold encrypted, and the bidder keeps nothing.</b> the salt rides inside the ciphertext, so a lost browser no longer costs an allocation. a bid whose ciphertext does not open to what was committed is voided and refunded; it cannot hold up anyone else.</p>
        </div>
        <div class="sl-limit">
          <span class="ml-chip ml-chip-build">build</span>
          <p><b>the reveal root is signed, not verified onchain.</b> the contract trusts a threshold of committee signatures over the root rather than checking the decryption shares itself. tempo has the pairing precompile and the gas has been measured, so this is scheduled work rather than an open question.</p>
        </div>
        <div class="sl-limit">
          <span class="ml-chip ml-chip-build">build</span>
          <p><b>the demo committee is a prop.</b> its five signing keys are derived from a published string so anyone can reproduce the demo. the seeded bids on the live page are therefore readable, and the page says so on each one.</p>
        </div>
        <div class="sl-limit">
          <span class="ml-chip ml-chip-live">live</span>
          <p><b>no audit, and a testnet only.</b> the contracts pass 87 tests including adversarial ones. that is not an audit, and nothing here has held real money.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="ml-section sl-cta-band">
    <div class="ml-wrap scroll-reveal">
      <h2 class="ml-h2">seal now. clear together.</h2>
      <p class="ml-sub">a live auction is open right now, with real escrow and bids sealed to the committee.</p>
      <div class="ml-hero-ctas"><a class="ml-cta" href="#/sealed-bid-auction">open the live auction</a></div>
    </div>
  </section>
</div>`;

  // The hero loop. Eight beats, and the order is the argument: the open book
  // is read and then beaten by one tick, while the sealed book sits inert
  // through exactly those beats. Only after the close does it open, all at
  // once, and settle at one price.
  //
  // Phase classes on the stage; CSS does the transitions. Nothing is animated
  // per frame, so this costs almost nothing and stops dead under
  // prefers-reduced-motion, where it parks on the beat that shows the most.
  const stage = root.querySelector<HTMLElement>('#sl-stage');
  let beat = reduced() ? 6 : 0;
  const paint = (): void => {
    if (!stage) return;
    stage.classList.toggle('is-scan', beat === 1);
    stage.classList.toggle('is-snipe', beat >= 2 && beat <= 4);
    stage.classList.toggle('is-open', beat >= 5);
    stage.classList.toggle('is-cleared', beat >= 6);
  };
  paint();

  let timer = 0;
  if (!reduced()) {
    timer = window.setInterval(() => {
      beat = (beat + 1) % 8;
      paint();
    }, 1200);
  }

  const stopReveal = mountScrollReveal(root);

  return () => {
    if (timer) clearInterval(timer);
    stopReveal?.();
    document.title = prevTitle;
  };
}
