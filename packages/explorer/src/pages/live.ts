// Peal Live: the auction itself, as a bidder and as the host see it.
//
// One page covers the whole life of an auction because it is one URL: while it
// is open you get a form, and when it closes the same link becomes the board.
// A viewer who arrives late is not sent somewhere else, and a link posted in a
// chat keeps working after the stream ends.
//
// The bidder needs no wallet, no sign in, no gas and no extension. Everything
// that identifies the auction lives in the fragment, so opening a link tells no
// server which auction was opened.
import { BteClient } from 'bte-sdk';
import {
  AmountError, CURRENCIES, MAX_CONTACT_BYTES, buildBoard, canConvert, checksum, convertMinor,
  crossRate, ctHashOf, decodeBid, encodeBid, findCurrency, isStale,
  type BidOrigin, type RateTable,
  formatAmount, openContact, parseAmount, receiptCode, sealContact, sealedBytes, unpackTerms,
  type Board, type Terms,
} from 'peal-live';
import { API_BASE, getCondition, getReveal, type ConditionDetail, type Reveal } from '../api';
import { isHostOf, readSellerKey, rememberAuction } from '../live-recent';
import { cachedRates, rates } from '../live-rates';
import { findTermsAnchor } from '../live-chain';
import { wireCopy } from '../playground';
import { esc, fmtCountdown } from '../util';

type Cleanup = () => void;

const POLL_MS = 2000;

/** The ct hash of the bid this browser made, per auction.
 *
 * Only the hash. The amount is never persisted: it is public the moment the
 * batch opens, and until then writing it down would put a readable bid on the
 * device for no benefit, since the committee is what reopens it. Compare
 * auction.ts:139-143, where a salt IS persisted because it exists nowhere else
 * and losing it voids the bid. Nothing here is lost by forgetting.
 */
function myBidKey(auctionId: string): string {
  return `peal-live:${auctionId}`;
}

interface MyBid {
  ctHash: string;
  /** Whether this browser re-derived the hash from its own ciphertext rather
   * than taking the coordinator's word. Stored, because it is the difference
   * between two different sentences on screen and it cannot be recovered after
   * a reload. */
  derived: boolean;
}

function readMyBid(auctionId: string): MyBid | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(myBidKey(auctionId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { ctHash, derived } = parsed as Partial<MyBid>;
    // Anything that is not a ct hash is not a receipt. Trusting the value
    // blindly let a stray key claim a bid existed and hide the form, which
    // locks somebody out of an auction on the strength of a typo.
    if (typeof ctHash !== 'string' || !/^[0-9a-f]{64}$/.test(ctHash)) return null;
    return { ctHash, derived: derived === true };
  } catch {
    return null;
  }
}

/** Who the seller has already passed over, on this device only.
 *
 * Deliberately not part of the auction. Whether somebody paid happens off this
 * page entirely, and writing it into the shared record would be the page
 * claiming to know something it cannot. The batch and its ordering are the
 * record; this is a seller's note to themselves while they read down the list.
 */
function passedKey(auctionId: string): string {
  return `peal-live-passed:${auctionId}`;
}

function readPassed(auctionId: string): Set<string> {
  try {
    const raw = localStorage.getItem(passedKey(auctionId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((h): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)));
  } catch {
    return new Set();
  }
}

function writePassed(auctionId: string, passed: ReadonlySet<string>): void {
  try {
    localStorage.setItem(passedKey(auctionId), JSON.stringify([...passed]));
  } catch {
    // Private windows refuse storage; the list simply does not persist.
  }
}

function rememberMyBid(auctionId: string, bid: MyBid): void {
  try {
    localStorage.setItem(myBidKey(auctionId), JSON.stringify(bid));
  } catch {
    // Private windows refuse storage. The bid is already sealed and counted;
    // this browser just will not be able to point at its own row later.
  }
}

function notFound(message: string): string {
  return `
    <section class="live-page">
      <p class="live-kicker">peal live</p>
      <div class="card live-card">
        <p class="muted">${esc(message)}</p>
        <a class="btn" href="#/live">start your own auction</a>
      </div>
    </section>`;
}

/** Always available, so the row is never blank while a chain lookup runs. The
 * condition view does not depend on the terms record existing. */
function verificationLink(terms: Terms): string {
  return `<a class="link" href="#/condition/${encodeURIComponent(terms.auctionId)}">verification</a>`;
}

function shell(terms: Terms, code: string): string {
  const limits = [
    terms.reserveMinor === null
      ? '' : `reserve ${formatAmount(terms.reserveMinor, terms.decimals)}`,
    terms.maxMinor === null
      ? '' : `most ${formatAmount(terms.maxMinor, terms.decimals)}`,
  ].filter(Boolean);
  const reserve = limits.length
    ? `<p class="live-reserve">${esc(`${limits.join(' · ')} ${terms.unit}`)}</p>`
    : '';
  // The picture, when there is one, comes before everything else. Somebody
  // deciding what to bid is otherwise looking at a name and a number.
  //
  // It is hidden until it decodes, because a broken image icon reads as this
  // page being wrong rather than the address being wrong, and it carries no
  // referrer so opening an auction does not tell the image's host which auction
  // was opened.
  const picture = terms.image
    ? `<div class="live-photo" id="live-photo" hidden>
         <img src="${esc(terms.image)}" alt="${esc(terms.title)}" referrerpolicy="no-referrer" />
       </div>`
    : '';

  return `
    <section class="live-page">
      <p class="live-kicker">peal live</p>
      <h1 class="live-title">${esc(terms.title)}</h1>
      ${reserve}
      ${terms.description ? `<p class="live-about">${esc(terms.description)}</p>` : ''}
      ${picture}
      <div class="live-meta">
        <div class="live-meta-cell">
          <span class="live-meta-label">closes in</span>
          <span class="live-meta-value mono" id="live-clock">—</span>
        </div>
        <div class="live-meta-cell">
          <span class="live-meta-label">bids sealed</span>
          <span class="live-meta-value mono" id="live-count">—</span>
        </div>
        <div class="live-meta-cell">
          <span class="live-meta-label">check</span>
          <span class="live-meta-value mono" id="live-code">${esc(code)}</span>
        </div>
      </div>
      <div id="live-panel"></div>
      <p class="live-anchor" id="live-anchor">${verificationLink(terms)}</p>
      <p class="live-foot">Every bid is scrambled on the device that made it, so the seller cannot
      read one before the close and neither can anyone else bidding. Opening them early takes three
      of the five keys at once.</p>
    </section>`;
}

function bidForm(
  terms: Terms,
  mine: MyBid | null,
  table: RateTable | null,
  bidCurrency: string,
): string {
  if (mine) {
    return `
      <div class="card live-card live-in">
        <p class="live-in-head">your bid is sealed</p>
        <p class="muted">The seller cannot read it before the close, and neither can the other
        bidders. Opening it early takes three of the five keys at once. It opens with everyone
        else's at the same moment.</p>
        <p class="live-receipt-label">your receipt</p>
        <p class="live-receipt mono">${esc(receiptCode(mine.ctHash))}</p>
        <p class="field-hint">When the timer ends, look for this next to your name. ${
          mine.derived
            ? 'It comes from your own bid, worked out on this device, so it is not us telling you which row is yours: you can see it.'
            : 'This one came back from the network, because this device could not re-read the bid it made.'
        }</p>
      </div>`;
  }
  // The currency picker only appears once rates are in hand. Without them
  // there is nothing honest to convert with, so the form is exactly what it
  // was: one currency, the auction's own.
  const chosen = findCurrency(bidCurrency) ?? findCurrency(terms.unit);
  const decimals = chosen?.decimals ?? terms.decimals;
  const options = table
    ? CURRENCIES.filter((c) => canConvert(table, c.code, terms.unit))
    : [];
  return `
    <div class="card live-card">
      <label class="live-label" for="live-amount">your bid</label>
      <div class="live-amountrow">
        <input class="live-input live-amount" id="live-amount" inputmode="decimal"
               autocomplete="off" placeholder="0${decimals ? '.00' : ''}" />
        ${options.length > 1
          ? `<select class="live-unit live-unit-pick" id="live-currency"
                     aria-label="the currency you are bidding in">
              ${options.map((c) => `<option value="${esc(c.code)}"${
                c.code === bidCurrency ? ' selected' : ''}>${esc(c.code)}</option>`).join('')}
            </select>`
          : `<span class="live-unit">${esc(terms.unit)}</span>`}
      </div>
      <p class="live-convert" id="live-convert" hidden></p>
      <label class="live-label" for="live-name">name on the board</label>
      <input class="live-input" id="live-name" maxlength="24" autocomplete="off" placeholder="anon" />
      ${terms.contactKey ? `
      <label class="live-label" for="live-contact">how the seller can reach you</label>
      <input class="live-input" id="live-contact" maxlength="${MAX_CONTACT_BYTES - 1}"
             autocomplete="off" placeholder="a number, a handle, an email" />
      <p class="field-hint">Optional, and only the seller can read it. It is locked to their key
      on this device before it is sent, so when every bid opens the other bidders see nothing here
      but scrambled bytes.</p>` : ''}
      <button class="btn btn-primary live-go" id="live-bid">seal my bid</button>
      <p class="live-error" id="live-bid-err" hidden></p>
      <p class="field-hint">The seller cannot read your bid, and neither can the person bidding
      against you. Everything opens at once when the timer hits zero, so no one can sit on your
      number and top it at the last second.<br />
      <strong>Bid what it is really worth to you.</strong> No wallet, no sign up, nothing to
      install.</p>
    </div>`;
}

/** A message that has to outlive the panel it was raised in.
 *
 * The 2s poll can flip the panel from the bid form to "bidding is closed"
 * between a click and the coordinator's answer. Writing the error into the
 * form's own element then wrote it into a node that had already been replaced,
 * so a bid rejected at the close told the bidder nothing at all and they
 * walked away thinking they had bid. */
function noticeHtml(notice: string | null): string {
  return notice ? `<p class="live-error live-notice">${esc(notice)}</p>` : '';
}

/** Shown when the coordinator does not have this condition at all.
 *
 * Without this, a link naming an auction that never existed polled a 404 twice
 * a second forever and told the viewer nothing, or worse showed a working bid
 * form for an auction with no way to receive a bid. */
function unknownAuction(): string {
  return `
    <div class="card live-card">
      <p class="live-in-head">this auction is not on the network</p>
      <p class="muted">The link is well formed, but the coordinator does not have it. It may have
      been created against a different network, or the devnet it lived on was reset.</p>
      <a class="btn" href="#/live">start your own auction</a>
    </div>`;
}

function waiting(): string {
  return `
    <div class="card live-card">
      <p class="live-in-head">bidding is closed</p>
      <p class="muted">The committee is opening the batch. Every bid appears at once, in a
      moment.</p>
      <div class="skeleton-row"><span class="skeleton" style="width:220px"></span></div>
    </div>`;
}

/** What the auction raised, in the auction's currency and in the ones its
 * bidders used.
 *
 * The first figure is the real one: every bid was committed in the auction's
 * currency and this is their sum, exact and reproducible from the reveal alone.
 * The rest are that same total priced in other currencies at today's daily
 * rate, which is a different kind of number and is labelled as one. It moves
 * tomorrow; the total does not.
 *
 * Which currencies are shown is decided by the bidders: the ones people
 * actually bid in, plus the auction's own. A fixed list would show a Nepali
 * seller a column of yen.
 */
function totalsPanel(board: Board, terms: Terms, table: RateTable | null): string {
  if (board.queue.length === 0) return '';

  // The queue, not every bid: a bid over the maximum or under the reserve was
  // never money the seller could take.
  const totalMinor = board.queue.reduce((sum, b) => sum + b.amountMinor, 0);
  const primary = `${formatAmount(totalMinor, terms.decimals)} ${terms.unit}`;

  const used = new Set(board.queue.map((b) => b.origin?.code).filter((c): c is string => !!c));
  used.delete(terms.unit);
  const others = [...used]
    .map((code) => {
      const to = findCurrency(code);
      const rate = table && to ? crossRate(table, terms.unit, code) : null;
      if (!to || rate === null) return null;
      const converted = convertMinor(totalMinor, terms.decimals, to.decimals, rate);
      return `${formatAmount(converted, to.decimals)} ${to.code}`;
    })
    .filter((x): x is string => x !== null);

  const dated = table
    ? new Date(table.asOf).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    : null;

  return `
    <div class="live-totals">
      <p class="live-total-main">raised <strong>${esc(primary)}</strong>
        <span class="muted">across ${board.queue.length} bid${board.queue.length === 1 ? '' : 's'}
        in the queue</span></p>
      ${others.length
        ? `<p class="live-total-alt">about ${esc(others.join(' · '))}${
             dated ? `, at the daily rate for ${esc(dated)}` : ''}</p>`
        : ''}
      <p class="field-hint">The first figure is what was bid, and it does not change. The others are
      that same total priced today, so they will read differently tomorrow. Nothing was escrowed, so
      this is what people committed to rather than what has been collected.</p>
    </div>`;
}

function boardPanel(
  board: Board,
  terms: Terms,
  mine: MyBid | null,
  passed: ReadonlySet<string>,
  seller: boolean,
  contacts: ReadonlyMap<string, string>,
  table: RateTable | null,
): string {
  if (board.bids.length === 0) {
    return `<div class="card live-card"><p class="live-in-head">no bids</p>
      <p class="muted">The auction closed with nothing sealed to it.</p></div>`;
  }
  // Positions are the QUEUE's, not the board's, so a bid that cannot win does
  // not occupy a place in the line. Passing over the top one is local to this
  // device: nothing here can know whether somebody paid.
  const place = new Map(board.queue.map((b, i) => [b.ctHash, i]));
  // Only the seller's own device has worked down the list, so only it applies
  // that. A bidder always sees the real order: showing them a queue somebody
  // else had already stepped past would be showing them a result that is not
  // the auction's.
  const skipped = seller ? passed : new Set<string>();
  const standing = board.queue.filter((b) => !skipped.has(b.ctHash));
  const next = standing[0] ?? null;

  const rows = board.bids
    .map((b) => {
      const yours = mine !== null && b.ctHash === mine.ctHash;
      const isNext = next?.ctHash === b.ctHash;
      const isSkipped = skipped.has(b.ctHash);
      const rank = place.get(b.ctHash);
      const cls = ['live-row', isNext ? 'is-won' : '', yours ? 'is-mine' : '', isSkipped ? 'is-passed' : '']
        .filter(Boolean).join(' ');
      // Only ever populated on the seller's device: opening one needs the key
      // that never left it.
      const reach = contacts.get(b.ctHash);
      const why = !b.withinCap
        ? '<span class="live-under">over the maximum</span>'
        : !b.meetsReserve
          ? '<span class="live-under">under the reserve</span>'
          : isSkipped
            ? '<span class="live-under">you marked this one unpaid</span>'
            : '';
      return `<li class="${cls}" data-ct="${esc(b.ctHash)}">
        <span class="live-rank mono">${rank === undefined ? '—' : rank + 1}</span>
        <span class="live-who">${esc(b.name || 'anon')}
          <span class="live-code mono" title="the receipt this bid was sealed under">${esc(receiptCode(b.ctHash))}</span>
          ${yours ? '<span class="live-tag">you</span>' : ''}</span>
        <span class="live-bidamt mono">${esc(formatAmount(b.amountMinor, terms.decimals))}${
          b.origin
            ? `<span class="live-origin" title="what this bidder typed, converted when they bid"
                     >${esc(`${formatAmount(b.origin.amountMinor, b.origin.decimals)} ${b.origin.code}`)}</span>`
            : ''}</span>
        ${why}
        ${reach ? `<span class="live-reach">${esc(reach)}</span>` : ''}
      </li>`;
    })
    .join('');

  const head = next
    ? `<p class="live-won">${esc(next.name || 'anon')} ${seller && skipped.size ? 'is next in line at' : 'is first in line at'}
       ${esc(formatAmount(next.amountMinor, terms.decimals))} ${esc(terms.unit)}</p>`
    : board.queue.length
      ? `<p class="live-won">everybody in the queue has been passed over</p>`
      : `<p class="live-won">no winner: no bid landed inside the reserve and the maximum</p>`;

  // Seller only, and it used to be shown to everybody. A bidder could press it,
  // watch their own name move to the top, and be told they had won. It changes
  // nothing anyone else sees, which made it worse rather than harmless: the page
  // was telling one person a result that was not real.
  const control = !seller
    ? ''
    : next
      ? `<button class="btn live-pass" id="live-pass" data-ct="${esc(next.ctHash)}">
           ${esc(next.name || 'anon')} did not pay, go to the next
         </button>
         <p class="field-hint">Your list, on this device only. Nobody else's page changes, because
         whether someone paid happens somewhere this page cannot see.</p>`
      : skipped.size
        ? `<button class="btn live-pass" id="live-unpass">start the list again</button>`
        : '';

  const totals = totalsPanel(board, terms, table);

  const replayed = board.discarded.filter((d) => d.reason === 'other-auction').length;
  const outside = board.bids.length - board.queue.length;
  const notes = [
    `${board.bids.length} bid${board.bids.length === 1 ? '' : 's'} opened together`,
    outside ? `${outside} outside the reserve or the maximum` : '',
    `${board.padding} decoy slot${board.padding === 1 ? '' : 's'} the coordinator added to fill the batch`,
    replayed ? `${replayed} discarded for naming a different auction` : '',
  ].filter(Boolean);

  return `
    <div class="card live-card">
      ${head}
      <ol class="live-board">${rows}</ol>
      ${totals}
      ${control}
      <p class="field-hint">${esc(notes.join(' · '))}. Ties break on the batch's own ordering, which
      comes from the ciphertext hashes and is not the order bids arrived in. Nothing was escrowed,
      so this settles who bid the most and not the payment.</p>
    </div>`;
}

export function renderLive(root: HTMLElement, packed: string): Cleanup {
  const parsed = unpackTerms(packed);
  if (!parsed) {
    root.innerHTML = notFound('this link is not a Peal Live auction. it may have been truncated on the way here.');
    return () => {};
  }
  // Rebound so the helpers below see a Terms rather than a Terms | null. They
  // are function declarations, which hoist, so the guard above does not narrow
  // into them.
  const terms: Terms = parsed;

  const client = new BteClient({ url: API_BASE });
  let stale = false;
  let pollTimer: number | undefined;
  let tickTimer: number | undefined;
  let condition: ConditionDetail | null = null;
  let reveal: Reveal | null = null;
  let mine: MyBid | null = readMyBid(terms.auctionId);
  /** Rates for the currency picker. Starts with whatever this device already
   * cached, so the picker is there on first paint rather than appearing a
   * second later, and is refreshed in the background. */
  let rateTable: RateTable | null = cachedRates();
  /** What the bidder is typing in. The auction's own currency until they say
   * otherwise, so the default is always the one that needs no conversion. */
  let bidCurrency = terms.unit;

  // Refreshed in the background. The form is already usable with the auction's
  // own currency, so this only ever adds choices; it never gates the bid.
  void rates().then((table) => {
    if (!table || table === rateTable) return;
    rateTable = table;
    if (phase === 'open' && !mine) paintPanel(true);
  });
  let passed: Set<string> = readPassed(terms.auctionId);
  /** Contact details, opened with the seller's own key. Empty on every other
   * device, because opening one needs a key that only exists on theirs. */
  const contacts = new Map<string, string>();
  let contactsFor: string | null = null;
  /** Whether this browser created the auction. Decides whether the seller's
   * controls are offered at all. */
  const seller = isHostOf(packed);
  let phase: 'open' | 'waiting' | 'done' | null = null;
  let sealing = false;
  /** Survives a repaint. See noticeHtml. */
  let notice: string | null = null;
  /** Consecutive failed loads while we have never seen this condition. */
  let misses = 0;
  let missing = false;

  // Warm the wasm and the committee parameters now, so the first bid pays for
  // the seal alone. mempool.ts:427 does the same before a swap.
  void client.committee().catch(() => {});

  void checksum(terms).then((code) => {
    if (stale) return;
    root.innerHTML = shell(terms, code);
    const photo = root.querySelector<HTMLElement>('#live-photo');
    const img = photo?.querySelector('img');
    if (photo && img) {
      img.addEventListener('load', () => { photo.hidden = false; });
      img.addEventListener('error', () => photo.remove());
      // A cached image can finish decoding before this listener exists.
      if (img.complete && img.naturalWidth > 0) photo.hidden = false;
    }
    paint();
    paintPanel();
    void paintAnchor();
  });

  /** One line, and a way through to the detail.
   *
   * The long version of this used to sit under every auction explaining what a
   * block number did and did not prove. That is a paragraph of caveats on a
   * page whose job is a bid, and it belongs where somebody has actually gone
   * looking: the condition view already carries the batch, the shares and the
   * merkle root, so this links there and says nothing it cannot say in a
   * clause. */
  async function paintAnchor(): Promise<void> {
    const found = await findTermsAnchor(terms);
    if (stale) return;
    const row = root.querySelector<HTMLElement>('#live-anchor');
    if (!row) return;
    const detail = verificationLink(terms);
    if (found.state === 'anchored') {
      row.innerHTML = `terms recorded before any bid opened · ${detail}`;
      row.classList.add('is-on');
    } else if (found.state === 'unreachable' || found.state === 'out-of-window') {
      row.innerHTML = detail;
    } else {
      row.innerHTML = `terms not recorded · ${detail}`;
      row.classList.add('is-off');
    }
  }

  function currentPhase(): 'open' | 'waiting' | 'done' {
    if (reveal) return 'done';
    const closed = condition?.status === 'revealed' || Date.now() / 1000 >= terms.closeAt;
    return closed ? 'waiting' : 'open';
  }

  function paint(): void {
    const clock = root.querySelector<HTMLElement>('#live-clock');
    const count = root.querySelector<HTMLElement>('#live-count');
    if (clock) {
      const left = Math.max(0, terms.closeAt - Math.floor(Date.now() / 1000));
      clock.textContent = left > 0 ? fmtCountdown(left) : 'closed';
    }
    if (count) count.textContent = condition ? String(condition.real_count) : '—';
    if (clock && missing) clock.textContent = 'unknown';
  }

  /** Rebuilds the panel only when the phase changes or a bid lands, so typing
   * in the amount field is never interrupted by the 2s poll. */
  function paintPanel(force = false): void {
    const panel = root.querySelector<HTMLElement>('#live-panel');
    if (!panel) return;
    if (missing) {
      panel.innerHTML = noticeHtml(notice) + unknownAuction();
      return;
    }
    const next = currentPhase();
    if (!force && next === phase) return;
    phase = next;
    panel.innerHTML =
      noticeHtml(notice) +
      (next === 'done' && reveal
        ? boardPanel(buildBoard(reveal.slots, terms), terms, mine, passed, seller, contacts, rateTable)
        : next === 'waiting'
          ? waiting()
          : bidForm(terms, mine, rateTable, bidCurrency));
    wireCopy(panel);
    if (next === 'open' && !mine) wireBid(panel);

    panel.querySelector('#live-pass')?.addEventListener('click', (ev) => {
      const ct = (ev.currentTarget as HTMLElement).dataset.ct;
      if (!ct) return;
      passed.add(ct);
      writePassed(terms.auctionId, passed);
      paintPanel(true);
    });
    panel.querySelector('#live-unpass')?.addEventListener('click', () => {
      passed = new Set();
      writePassed(terms.auctionId, passed);
      paintPanel(true);
    });
  }

  /** What the bidder typed, converted into the auction's currency.
   *
   * Returns null when no conversion is needed or possible. Throws only what
   * parseAmount throws, so the caller reports one kind of error.
   */
  function convertTyped(typed: string): { committed: number; origin: BidOrigin } | null {
    if (bidCurrency === terms.unit) return null;
    const from = findCurrency(bidCurrency);
    const rate = rateTable && from ? crossRate(rateTable, bidCurrency, terms.unit) : null;
    if (!from || rate === null) return null;

    const amountMinor = parseAmount(typed, from.decimals);
    return {
      committed: convertMinor(amountMinor, from.decimals, terms.decimals, rate),
      origin: { code: from.code, amountMinor, decimals: from.decimals },
    };
  }

  function wireBid(panel: HTMLElement): void {
    const go = panel.querySelector<HTMLButtonElement>('#live-bid');
    const err = panel.querySelector<HTMLElement>('#live-bid-err');
    const amountEl = panel.querySelector<HTMLInputElement>('#live-amount');
    const nameEl = panel.querySelector<HTMLInputElement>('#live-name');
    if (!go || !err || !amountEl || !nameEl) return;

    const pick = panel.querySelector<HTMLSelectElement>('#live-currency');
    const convertEl = panel.querySelector<HTMLElement>('#live-convert');

    /** Show what will actually be committed, before it is committed.
     *
     * The converted figure IS the bid, so a bidder must see it while they can
     * still change their mind. Anything unparseable simply shows nothing:
     * complaining about a half-typed number as it is typed is noise. */
    const preview = (): void => {
      if (!convertEl) return;
      if (bidCurrency === terms.unit) {
        convertEl.hidden = true;
        return;
      }
      let converted: { committed: number; origin: BidOrigin } | null = null;
      try {
        converted = convertTyped(amountEl.value);
      } catch {
        converted = null;
      }
      if (!converted || !amountEl.value.trim()) {
        convertEl.hidden = true;
        return;
      }
      const when = rateTable ? new Date(rateTable.asOf) : null;
      const dated = when
        ? when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
        : 'today';
      // "Daily", not "live". The provider republishes once a day and saying
      // otherwise would be a small lie on a page that asks to be believed.
      const old = rateTable && isStale(rateTable) ? ' this rate is more than a day old.' : '';
      convertEl.textContent =
        `you are bidding ${formatAmount(converted.committed, terms.decimals)} ${terms.unit}.`
        + ` converted at the daily rate for ${dated}.${old}`;
      convertEl.hidden = false;
    };

    amountEl.addEventListener('input', preview);
    pick?.addEventListener('change', () => {
      bidCurrency = pick.value;
      amountEl.placeholder = (findCurrency(bidCurrency)?.decimals ?? terms.decimals) ? '0.00' : '0';
      preview();
    });
    preview();

    const show = (message: string): void => {
      err.textContent = message;
      err.hidden = false;
    };

    const submit = async (): Promise<void> => {
      if (sealing) return;
      err.hidden = true;

      // The panel only repaints on the 2s poll, so the form can still be on
      // screen after the close. Refusing here means the bidder is told, rather
      // than sending a bid the coordinator will drop.
      if (Date.now() / 1000 >= terms.closeAt) {
        notice = 'bidding closed before that went through. nothing was sealed.';
        paintPanel(true);
        return;
      }

      let amountMinor: number;
      let origin: BidOrigin | null = null;
      try {
        const converted = convertTyped(amountEl.value);
        if (converted) {
          // What gets committed and ranked is the converted figure, which the
          // line under the input has been showing all along.
          amountMinor = converted.committed;
          origin = converted.origin;
          if (amountMinor <= 0) {
            show(`that is too small to be a bid in ${terms.unit}.`);
            return;
          }
        } else if (bidCurrency !== terms.unit) {
          // The picker offered a currency the rates can no longer price. Bid in
          // the auction's own rather than guess at a rate.
          show(`that currency cannot be converted right now. bid in ${terms.unit} instead.`);
          return;
        } else {
          amountMinor = parseAmount(amountEl.value, terms.decimals);
        }
      } catch (e) {
        show(e instanceof AmountError ? e.message : 'that is not an amount.');
        return;
      }

      sealing = true;
      go.disabled = true;
      go.textContent = 'sealing…';
      try {
        const typedContact = panel.querySelector<HTMLInputElement>('#live-contact')?.value.trim() ?? '';
        let contact: Uint8Array | null = null;
        if (terms.contactKey && typedContact) {
          try {
            contact = await sealContact(terms.contactKey, typedContact);
          } catch (e) {
            show(e instanceof Error ? e.message : 'those contact details could not be locked.');
            return;
          }
        }
        const bytes = encodeBid({
          auctionId: terms.auctionId, amountMinor, name: nameEl.value.trim().slice(0, 24), contact,
          origin,
        });
        const { ctHash, sealedB64 } = await client.seal(bytes, terms.auctionId);
        // Clear the typed amount as soon as it has been sealed. It is not
        // needed again and there is no reason to leave it on screen.
        amountEl.value = '';

        const local = sealedBytes(sealedB64);
        const derived = local ? await ctHashOf(local) : null;
        if (derived && derived !== ctHash) {
          // The coordinator named the ciphertext something other than what it
          // actually is. Do not record a receipt for a bid we cannot identify.
          notice = 'the coordinator returned a hash that does not match the ciphertext this browser made. your bid was not recorded.';
          paintPanel(true);
          return;
        }

        // Written before the mounted check, not after. The bid is already in
        // the batch by this point, so a bidder who navigated away mid-seal
        // would otherwise come back to an empty form and bid a second time.
        mine = { ctHash: derived ?? ctHash, derived: derived !== null };
        rememberMyBid(terms.auctionId, mine);
        // So this bid can be found again after the tab is closed. The link is
        // the auction, and without this the bidder has nowhere to look it up.
        rememberAuction({ packed, title: terms.title, closeAt: terms.closeAt, role: 'bidder' });
        if (stale) return;
        paintPanel(true);
      } catch (e) {
        if (stale) return;
        const message = e instanceof Error ? e.message : String(e);
        // The coordinator refuses a ciphertext once the condition leaves
        // pending, which is exactly what a bid arriving after the close looks
        // like. This goes through `notice` rather than the form's own error
        // slot, because by now the form may no longer be on the page.
        notice = /not pending|closed|frozen|400/i.test(message)
          ? 'bidding closed before that went through. nothing was sealed.'
          : `that did not go through: ${message}`;
        paintPanel(true);
      } finally {
        sealing = false;
        if (!stale && go.isConnected) {
          go.disabled = false;
          go.textContent = 'seal my bid';
        }
      }
    };

    go.addEventListener('click', () => void submit());
    amountEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') void submit();
    });
  }

  /** Open every contact this device holds the key for.
   *
   * Runs once per reveal, on the seller's device only. Every other browser has
   * the same bytes and no way through them, which is the whole arrangement. */
  async function openContacts(r: Reveal): Promise<void> {
    if (!seller || !terms.contactKey || contactsFor === r.condition_id) return;
    contactsFor = r.condition_id;
    const key = readSellerKey(terms.auctionId);
    if (!key) return;

    const board = buildBoard(r.slots, terms);
    for (const entry of board.bids) {
      const slot = r.slots.find((s) => s.ct_hash === entry.ctHash);
      if (!slot) continue;
      // The same base64 the board already decoded, opened once more here for
      // the one field the board cannot show without a key.
      const bytes = sealedBytes(slot.payload_b64);
      const bid = bytes ? decodeBid(bytes) : null;
      if (!bid?.contact) continue;
      const opened = await openContact(key, bid.contact);
      if (opened) contacts.set(entry.ctHash, opened);
    }
    if (!stale && contacts.size) paintPanel(true);
  }

  async function poll(): Promise<void> {
    if (missing) return;
    try {
      condition = await getCondition(terms.auctionId);
      misses = 0;
      if (stale) return;
      if (!reveal && condition.status === 'revealed') {
        reveal = await getReveal(terms.auctionId);
        if (reveal) void openContacts(reveal);
      }
    } catch {
      if (stale) return;
      // A failure once the auction has loaded is a blip: nothing on screen
      // changes and the next poll runs in two seconds. A failure when it has
      // NEVER loaded is different, and repeating it forever is how a link to an
      // auction that does not exist became an indefinite drip of 404s from
      // every viewer's tab.
      if (!condition && ++misses >= 3) {
        missing = true;
        stopTimers();
        paintPanel(true);
      }
      return;
    }
    if (stale) return;
    paint();
    paintPanel();
  }

  function stopTimers(): void {
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    pollTimer = undefined;
    tickTimer = undefined;
  }

  void poll();
  pollTimer = window.setInterval(() => void poll(), POLL_MS);
  tickTimer = window.setInterval(paint, 1000);

  // A background tab throttles timers, so catch up the moment it is looked at.
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void poll();
  };
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    stale = true;
    stopTimers();
    document.removeEventListener('visibilitychange', onVisible);
  };
}
