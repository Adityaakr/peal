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
  AmountError, buildBoard, checksum, ctHashOf, encodeBid, formatAmount, parseAmount,
  sealedBytes, unpackTerms, type Board, type Terms,
} from 'peal-live';
import { API_BASE, getCondition, getReveal, type ConditionDetail, type Reveal } from '../api';
import { rememberAuction } from '../live-recent';
import { findTermsAnchor } from '../live-chain';
import { wireCopy } from '../playground';
import { esc, fmtCountdown, truncMiddle } from '../util';

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
      <p class="live-foot">Bids are encrypted in the browser that makes them, so the seller cannot
      read one before the close and neither can the other bidders. Opening the batch early would
      take 3 of the 5 committee operators. The close is kept by our coordinator's clock rather than
      enforced by the operators, and the committee's keys came from a single setup we ran, so this
      is a fair reveal, not a trustless one. Nothing is escrowed: a bid is not a payment.</p>
    </section>`;
}

function bidForm(terms: Terms, mine: MyBid | null): string {
  if (mine) {
    return `
      <div class="card live-card live-in">
        <p class="live-in-head">your bid is sealed</p>
        <p class="muted">The seller cannot read it before the close, and neither can the other
        bidders. Opening it early would take 3 of the 5 committee operators. It opens with
        everyone else's at the same moment.</p>
        <p class="live-hash mono">${esc(truncMiddle(mine.ctHash, 12, 10))}
          <button class="btn live-copy" data-copy="${esc(mine.ctHash)}">copy</button></p>
        <p class="field-hint">${
          mine.derived
            ? 'This browser derived that hash from your own ciphertext, so it is not the coordinator&rsquo;s word for it.'
            : 'That hash is the coordinator&rsquo;s: this browser could not re-read the ciphertext it made.'
        } It is how you will find your row on the board.</p>
      </div>`;
  }
  return `
    <div class="card live-card">
      <label class="live-label" for="live-amount">your bid</label>
      <div class="live-amountrow">
        <input class="live-input live-amount" id="live-amount" inputmode="decimal"
               autocomplete="off" placeholder="0${terms.decimals ? '.00' : ''}" />
        <span class="live-unit">${esc(terms.unit)}</span>
      </div>
      <label class="live-label" for="live-name">name on the board</label>
      <input class="live-input" id="live-name" maxlength="24" autocomplete="off" placeholder="anon" />
      <button class="btn btn-primary live-go" id="live-bid">seal my bid</button>
      <p class="live-error" id="live-bid-err" hidden></p>
      <p class="field-hint">The seller cannot see your bid, and neither can anyone bidding against
      you. Every bid opens at once when the timer hits zero, so nobody can beat yours by a fraction
      at the last second.<br />
      Bid what it is really worth to you. No wallet, no sign up, nothing to install.</p>
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

function boardPanel(board: Board, terms: Terms, mine: MyBid | null, passed: ReadonlySet<string>): string {
  if (board.bids.length === 0) {
    return `<div class="card live-card"><p class="live-in-head">no bids</p>
      <p class="muted">The auction closed with nothing sealed to it.</p></div>`;
  }
  // Positions are the QUEUE's, not the board's, so a bid that cannot win does
  // not occupy a place in the line. Passing over the top one is local to this
  // device: nothing here can know whether somebody paid.
  const place = new Map(board.queue.map((b, i) => [b.ctHash, i]));
  const standing = board.queue.filter((b) => !passed.has(b.ctHash));
  const next = standing[0] ?? null;

  const rows = board.bids
    .map((b) => {
      const yours = mine !== null && b.ctHash === mine.ctHash;
      const isNext = next?.ctHash === b.ctHash;
      const skipped = passed.has(b.ctHash);
      const rank = place.get(b.ctHash);
      const cls = ['live-row', isNext ? 'is-won' : '', yours ? 'is-mine' : '', skipped ? 'is-passed' : '']
        .filter(Boolean).join(' ');
      const why = !b.withinCap
        ? '<span class="live-under">over the maximum</span>'
        : !b.meetsReserve
          ? '<span class="live-under">under the reserve</span>'
          : skipped
            ? '<span class="live-under">passed over on this device</span>'
            : '';
      return `<li class="${cls}" data-ct="${esc(b.ctHash)}">
        <span class="live-rank mono">${rank === undefined ? '—' : rank + 1}</span>
        <span class="live-who">${esc(b.name || 'anon')}${yours ? '<span class="live-tag">you</span>' : ''}</span>
        <span class="live-bidamt mono">${esc(formatAmount(b.amountMinor, terms.decimals))}</span>
        ${why}
      </li>`;
    })
    .join('');

  const head = next
    ? `<p class="live-won">${esc(next.name || 'anon')} is first in line at
       ${esc(formatAmount(next.amountMinor, terms.decimals))} ${esc(terms.unit)}</p>`
    : board.queue.length
      ? `<p class="live-won">everybody in the queue has been passed over</p>`
      : `<p class="live-won">no winner: no bid landed inside the reserve and the maximum</p>`;

  // The seller works down the list out loud. Nothing about payment can live in
  // the auction, so this control is explicitly this browser's note to itself
  // rather than a change to the result everyone else sees.
  const control = next
    ? `<button class="btn live-pass" id="live-pass" data-ct="${esc(next.ctHash)}">
         they did not pay, go to the next
       </button>
       <p class="field-hint">only on this device. the batch and its order are the record; who
       actually paid is not something this page can know.</p>`
    : passed.size
      ? `<button class="btn live-pass" id="live-unpass">start the list again</button>`
      : '';

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
  let passed: Set<string> = readPassed(terms.auctionId);
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
        ? boardPanel(buildBoard(reveal.slots, terms), terms, mine, passed)
        : next === 'waiting'
          ? waiting()
          : bidForm(terms, mine));
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

  function wireBid(panel: HTMLElement): void {
    const go = panel.querySelector<HTMLButtonElement>('#live-bid');
    const err = panel.querySelector<HTMLElement>('#live-bid-err');
    const amountEl = panel.querySelector<HTMLInputElement>('#live-amount');
    const nameEl = panel.querySelector<HTMLInputElement>('#live-name');
    if (!go || !err || !amountEl || !nameEl) return;

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
      try {
        amountMinor = parseAmount(amountEl.value, terms.decimals);
      } catch (e) {
        show(e instanceof AmountError ? e.message : 'that is not an amount.');
        return;
      }

      sealing = true;
      go.disabled = true;
      go.textContent = 'sealing…';
      try {
        const bytes = encodeBid({
          auctionId: terms.auctionId, amountMinor, name: nameEl.value.trim().slice(0, 24),
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

  async function poll(): Promise<void> {
    if (missing) return;
    try {
      condition = await getCondition(terms.auctionId);
      misses = 0;
      if (stale) return;
      if (!reveal && condition.status === 'revealed') {
        reveal = await getReveal(terms.auctionId);
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
