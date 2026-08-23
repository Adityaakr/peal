// Finds Peal seal links on the page and puts a live countdown next to them.
//
// The hard part is not the countdown, it is finding the link at all. On X every
// href is rewritten to t.co, so the destination is not in the href — it is in
// the text X renders inside the anchor, which X truncates with an ellipsis when
// it is long. A public short link is 36 characters and survives intact; the
// 119-character form Peal used before short codes did not. That is why this
// only became practical after the link got shorter.

const MARK = 'data-peal-card';
const TICK_MS = 1000;
const RESCAN_DEBOUNCE_MS = 300;

/** Cards currently on the page, so one interval drives all of them. */
const live = new Set();
let ticking = null;

// -- countdown formatting ----------------------------------------------------

function fmt(secs) {
  if (secs <= 0) return 'any moment';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  // Two units, largest first. Reads at a glance in a timeline, where a
  // zero-padded clock just looks like a build log.
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + s + 's';
  return s + 's';
}

/** Local wall-clock time the seal opens, e.g. "9:41 pm · today". */
function fmtWhen(unix, verb) {
  if (unix == null) return '';
  const d = new Date(unix * 1000);
  let t;
  try {
    t = d
      .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      .toLowerCase();
  } catch (_) {
    t = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((d - midnight) / 86400000);
  let when;
  if (days === 0) when = 'today';
  else if (days === 1) when = 'tomorrow';
  else {
    try {
      when = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (_) {
      when = d.toDateString();
    }
  }
  return verb + ' ' + t + ' \u00b7 ' + when;
}

// -- the card ----------------------------------------------------------------

function buildCard(handle) {
  const card = document.createElement('div');
  card.className = 'peal-card peal-card--loading';
  card.setAttribute('role', 'status');
  // Shaped like an X media embed — 16:9, full column width — so it reads as
  // part of the post rather than as something bolted underneath it.
  card.innerHTML = `
    <div class="peal-card__head">
      <span class="peal-card__badge">
        <span class="peal-card__lock" aria-hidden="true"></span>
        <span class="peal-card__badgetext">sealed</span>
      </span>
      <span class="peal-card__brand" aria-hidden="true">peal</span>
    </div>
    <div class="peal-card__center">
      <div class="peal-card__kicker">nobody can read this yet</div>
      <div class="peal-card__time">&nbsp;</div>
      <div class="peal-card__label">checking\u2026</div>
    </div>
    <div class="peal-card__foot">
      <span class="peal-card__when"></span>
      <span class="peal-card__note">encrypted to a threshold committee</span>
    </div>`;
  card.dataset.pealHandle = `${handle.kind}:${handle.value}`;
  return card;
}

function paint(card, state) {
  const badge = card.querySelector('.peal-card__badgetext');
  const kicker = card.querySelector('.peal-card__kicker');
  const time = card.querySelector('.peal-card__time');
  const label = card.querySelector('.peal-card__label');
  const note = card.querySelector('.peal-card__note');
  const when = card.querySelector('.peal-card__when');
  card.classList.remove('peal-card--loading');

  if (!state) {
    card.classList.add('peal-card--unknown');
    badge.textContent = 'not found';
    kicker.textContent = 'unknown seal';
    time.textContent = '\u2014';
    label.textContent = 'this link may be for another network';
    note.textContent = 'peal.network';
    when.textContent = '';
    return;
  }

  if (state.status === 'revealed') {
    card.classList.add('peal-card--open');
    badge.textContent = 'opened';
    kicker.textContent = 'the wait is over';
    time.textContent = 'it\u2019s open';
    label.textContent = 'tap the link to read it';
    note.textContent = 'revealed on cue by a threshold committee';
    when.textContent = fmtWhen(state.firesAt, 'opened');
    return;
  }

  if (state.status === 'frozen') {
    card.classList.add('peal-card--opening');
    badge.textContent = 'opening';
    kicker.textContent = 'opening right now';
    time.textContent = 'unsealing\u2026';
    label.textContent = 'the committee is reassembling the key';
    note.textContent = 'no single operator can do this alone';
    when.textContent = fmtWhen(state.firesAt, 'opened');
    return;
  }

  if (state.kind === 'at_block' || state.firesAt == null) {
    badge.textContent = 'sealed';
    kicker.textContent = 'nobody can read this yet';
    time.textContent = 'at a block';
    label.textContent = 'opens on a chain height';
    note.textContent = 'encrypted to a threshold committee';
    when.textContent = 'at block ' + (state.height ?? '?');
    return;
  }

  const left = state.firesAt - Math.floor(Date.now() / 1000);
  badge.textContent = 'sealed';
  kicker.textContent = left > 0 ? 'nobody can read this yet' : 'opening right now';
  time.textContent = fmt(left);
  label.textContent = left > 0 ? 'until it opens' : 'any second now';
  note.textContent = 'not the sender, not the operators, not us';
  when.textContent = fmtWhen(state.firesAt, 'opens');
}

function startTicking() {
  if (ticking) return;
  ticking = setInterval(() => {
    if (live.size === 0) {
      clearInterval(ticking);
      ticking = null;
      return;
    }
    for (const card of Array.from(live)) {
      if (!card.isConnected) {
        live.delete(card);
        continue;
      }
      const state = card.__pealState;
      if (!state || state.status !== 'pending' || state.firesAt == null) continue;
      const left = state.firesAt - Math.floor(Date.now() / 1000);
      card.querySelector('.peal-card__time').textContent = fmt(left);
      // Past the cue the coordinator still has to freeze and gather shares, so
      // re-ask rather than sitting on a stale "any moment" forever.
      if (left <= 0 && !card.__pealRecheck) {
        card.__pealRecheck = true;
        setTimeout(() => hydrate(card), 4000);
      }
    }
  }, TICK_MS);
}

function hydrate(card) {
  const [kind, value] = card.dataset.pealHandle.split(':');
  chrome.runtime.sendMessage({ type: 'peal:resolve', handle: { kind, value } }, (resp) => {
    if (chrome.runtime.lastError) return; // worker asleep or page going away
    if (!resp || !resp.ok) return;
    card.__pealState = resp.value;
    card.__pealRecheck = false;
    paint(card, resp.value);
    if (resp.value && resp.value.status === 'pending') {
      live.add(card);
      startTicking();
    } else {
      live.delete(card);
    }
  });
}

// -- placement ---------------------------------------------------------------

/** The text X actually shows for a link, which is where the real URL hides. */
function candidateStrings(a) {
  const out = [];
  if (a.href) out.push(a.href);
  const text = (a.textContent || '').trim();
  if (text) out.push(text);
  const title = a.getAttribute('title');
  if (title) out.push(title.trim());
  return out;
}

function attach(a, handle) {
  a.setAttribute(MARK, '1');
  const card = buildCard(handle);
  // Sit the card after the closest block-ish ancestor inside the post, so it
  // does not land mid-sentence in the tweet text.
  let anchorPoint = a;
  const parent = a.parentElement;
  if (parent && parent.childElementCount <= 3 && parent !== document.body) {
    const display = getComputedStyle(parent).display;
    if (display === 'block' || display === 'flex') anchorPoint = parent;
  }
  anchorPoint.insertAdjacentElement('afterend', card);
  hydrate(card);
}

function scan(root) {
  const scope = root && root.querySelectorAll ? root : document;
  const anchors = scope.querySelectorAll(`a[href]:not([${MARK}])`);
  for (const a of anchors) {
    if (a.closest('.peal-card')) continue;
    let handle = null;
    for (const s of candidateStrings(a)) {
      handle = parseSealLink(s);
      if (handle) break;
    }
    if (handle) attach(a, handle);
  }
}

// -- lifecycle ---------------------------------------------------------------

let pending = null;
function scheduleScan() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    scan(document);
  }, RESCAN_DEBOUNCE_MS);
}

scan(document);

// Timelines are virtualised: posts mount and unmount constantly, so a one-shot
// scan sees almost nothing. Debounced so a fast scroll does not thrash.
new MutationObserver(scheduleScan).observe(document.documentElement, {
  childList: true,
  subtree: true,
});

// X is a SPA; a route change swaps the timeline without a page load.
window.addEventListener('popstate', scheduleScan);
