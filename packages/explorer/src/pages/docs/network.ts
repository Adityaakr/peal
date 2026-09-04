/**
 * The activity dashboard: what the network has actually done, drawn from the
 * coordinator's own tables.
 *
 * Everything on this page is work: rounds opened, payloads sealed, batches
 * opened, how long opening took, which tags it arrived under, and how many
 * times the agent skill finished installing. There is deliberately no visitor
 * count, no session count and no unique user count, because there are no
 * accounts on this network and nothing here observes a reader. A number nobody
 * can produce honestly is worse than a number that is missing, so the missing
 * ones are named at the bottom of the page rather than estimated.
 *
 * The charts are hand written SVG. They carry no dependency, they read the same
 * palette as the rest of the site, and at this size a charting library would be
 * larger than the page it draws on.
 */
import type { DocsPage } from '../../docs';
import { base } from './runner';
import { esc } from '../../util';

interface TagRow {
  tag: string;
  rounds: number;
  last_seen: number;
  recent: number;
}

interface DayRow {
  day: string;
  rounds: number;
  sealed: number;
  opened: number;
  skill_installs: number;
  paid_calls: number;
}

interface Activity {
  days: number;
  as_of: number;
  totals: {
    rounds: number;
    opened: number;
    open: number;
    sealed: number;
    decoys: number;
    batches: number;
    shares: number;
    auctions: number;
    skill_installs: number;
    paid_calls: number;
  };
  series: DayRow[];
  open_ms: { p50: number | null; p90: number | null; p99: number | null; samples: number };
  tags: TagRow[];
}

const nf = new Intl.NumberFormat();

/** Ranges the selector offers. Ninety is the server's own ceiling. */
const RANGES = [7, 30, 90] as const;

/** One colour per series, used by the chart, the legend and the stat cards so
 *  a colour means the same thing everywhere on the page. */
const SERIES = [
  { key: 'rounds', label: 'rounds', colour: '#2563eb' },
  { key: 'sealed', label: 'sealed', colour: '#0ea5e9' },
  { key: 'opened', label: 'opened', colour: '#16a34a' },
] as const;

type SeriesKey = (typeof SERIES)[number]['key'];

function ago(unix: number, now: number): string {
  const secs = Math.max(0, now - unix);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}

/** A duration a person can read at a glance, from milliseconds. */
function dur(ms: number | null): string {
  if (ms === null) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** `2026-09-04` as `4 Sep`. Parsed as UTC, which is what the server counted in;
 *  reading it as local time would slide every label by a day for anyone west of
 *  Greenwich. */
function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${d.getUTCDate()} ${d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`;
}

// ------------------------------------------------------------------ charts --

const W = 1000;
const H = 260;
const PAD = { top: 16, right: 12, bottom: 26, left: 44 };

/** A rounded ceiling for the axis, so the top gridline is a number a person
 *  would have chosen: 5, 10, 25, 50, 100, 250 and so on rather than 87. */
function niceMax(value: number): number {
  if (value <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * mag;
    if (candidate >= value) return candidate;
  }
  return 10 * mag;
}

function xAt(i: number, n: number): number {
  if (n <= 1) return PAD.left + (W - PAD.left - PAD.right) / 2;
  return PAD.left + (i / (n - 1)) * (W - PAD.left - PAD.right);
}

function yAt(v: number, max: number): number {
  return H - PAD.bottom - (v / max) * (H - PAD.top - PAD.bottom);
}

/**
 * The multi series line chart.
 *
 * Lines rather than stacked areas: the three series answer different questions
 * and stacking them would invite reading the top edge as a total, which it is
 * not. Each line gets a faint fill so a single active series still reads as
 * volume.
 */
function lineChart(series: DayRow[], active: Set<SeriesKey>): string {
  const n = series.length;
  const visible = SERIES.filter((s) => active.has(s.key));
  const peak = Math.max(
    1,
    ...visible.flatMap((s) => series.map((d) => d[s.key])),
  );
  const max = niceMax(peak);

  // Four gridlines. Integer labels only: half a round does not exist.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  const grid = [...new Set(ticks)]
    .map((v) => {
      const y = yAt(v, max);
      return `<line class="ch-grid" x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}"/>
        <text class="ch-ytick" x="${PAD.left - 10}" y="${y + 4}">${nf.format(v)}</text>`;
    })
    .join('');

  const paths = visible
    .map((s) => {
      const pts = series.map((d, i) => `${xAt(i, n).toFixed(1)},${yAt(d[s.key], max).toFixed(1)}`);
      const line = `M${pts.join('L')}`;
      const area = `${line}L${xAt(n - 1, n).toFixed(1)},${H - PAD.bottom}L${xAt(0, n).toFixed(1)},${H - PAD.bottom}Z`;
      return `<path class="ch-area" d="${area}" fill="${s.colour}"/>
        <path class="ch-line" d="${line}" stroke="${s.colour}"/>`;
    })
    .join('');

  // Roughly six date labels however long the window is, always including the
  // last day, which is the one people look for first.
  const every = Math.max(1, Math.ceil(n / 6));
  const xticks = series
    .map((d, i) =>
      (n - 1 - i) % every === 0
        ? `<text class="ch-xtick" x="${xAt(i, n).toFixed(1)}" y="${H - 8}">${esc(dayLabel(d.day))}</text>`
        : '',
    )
    .join('');

  const dots = visible
    .map((s) =>
      series
        .map(
          (d, i) =>
            `<circle class="ch-dot" data-i="${i}" cx="${xAt(i, n).toFixed(1)}" cy="${yAt(d[s.key], max).toFixed(1)}" r="3" fill="${s.colour}"/>`,
        )
        .join(''),
    )
    .join('');

  return `<svg class="ch" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="rounds, payloads sealed and batches opened per day">
      ${grid}${paths}${dots}${xticks}
      <line class="ch-cross" x1="0" y1="${PAD.top}" x2="0" y2="${H - PAD.bottom}" style="opacity:0"/>
    </svg>`;
}

/** Skill installs per day, as bars. A count of discrete events reads as bars;
 *  drawing it as a line would imply a value between Tuesday and Wednesday. */
function barChart(series: DayRow[]): string {
  const n = series.length;
  const max = niceMax(Math.max(1, ...series.map((d) => d.skill_installs)));
  const inner = W - PAD.left - PAD.right;
  const slot = inner / n;
  const bw = Math.max(2, Math.min(28, slot * 0.62));

  const grid = [0, 0.5, 1]
    .map((f) => {
      const v = Math.round(max * f);
      const y = yAt(v, max);
      return `<line class="ch-grid" x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}"/>
        <text class="ch-ytick" x="${PAD.left - 10}" y="${y + 4}">${nf.format(v)}</text>`;
    })
    .join('');

  const bars = series
    .map((d, i) => {
      const x = PAD.left + slot * i + (slot - bw) / 2;
      const y = yAt(d.skill_installs, max);
      const h = Math.max(d.skill_installs > 0 ? 2 : 0, H - PAD.bottom - y);
      return `<rect class="ch-bar" data-i="${i}" x="${x.toFixed(1)}" y="${(H - PAD.bottom - h).toFixed(1)}"
        width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2"/>`;
    })
    .join('');

  const every = Math.max(1, Math.ceil(n / 6));
  const xticks = series
    .map((d, i) =>
      (n - 1 - i) % every === 0
        ? `<text class="ch-xtick" x="${(PAD.left + slot * i + slot / 2).toFixed(1)}" y="${H - 8}">${esc(dayLabel(d.day))}</text>`
        : '',
    )
    .join('');

  return `<svg class="ch ch-bars" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="agent skill installs per day">${grid}${bars}${xticks}</svg>`;
}

/** Open latency as three bars against the slowest of them, so the shape of the
 *  tail is visible rather than three numbers in a row. */
function latency(o: Activity['open_ms']): string {
  if (o.samples === 0) {
    return '<p class="muted">no batch has been opened yet, so there is nothing to time.</p>';
  }
  const top = Math.max(1, o.p99 ?? 0, o.p90 ?? 0, o.p50 ?? 0);
  const rows = ([
    ['p50', o.p50, 'half of all opens finish inside this'],
    ['p90', o.p90, 'nine in ten finish inside this'],
    ['p99', o.p99, 'the slow tail'],
  ] as const)
    .map(([name, v, note]) => {
      const pct = v === null ? 0 : Math.max(1.5, (v / top) * 100);
      return `<li class="lat-row">
        <span class="lat-name mono">${name}</span>
        <span class="lat-bar"><i style="width:${pct.toFixed(1)}%"></i></span>
        <span class="lat-val mono">${esc(dur(v))}</span>
        <span class="lat-note">${note}</span>
      </li>`;
    })
    .join('');
  return `<ul class="lat">${rows}</ul>
    <p class="field-hint">Measured across ${nf.format(o.samples)} opened batch${o.samples === 1 ? '' : 'es'},
    from the moment the batch froze to the moment its payloads were readable. It covers the
    committee's work, not the wait for the deadline you set.</p>`;
}

// -------------------------------------------------------------------- page --

export const network: DocsPage = {
  title: 'Activity',
  lede: 'What the network has done, counted from the coordinator’s own tables. Nothing here is a figure somebody typed.',
  wide: true,
  html: `
    <div class="act-head">
      <div class="act-range" role="group" aria-label="time range">
        ${RANGES.map(
          (d) =>
            `<button type="button" class="act-range-btn${d === 30 ? ' is-on' : ''}" data-days="${d}">${d}d</button>`,
        ).join('')}
      </div>
      <p class="act-asof muted" id="act-asof">loading…</p>
    </div>

    <div class="act-cards" id="act-cards" aria-label="totals"></div>

    <h2 id="over-time">Over time</h2>
    <p>Rounds created, payloads sealed into them, and batches opened, per day. Quiet days are
    drawn as quiet days rather than skipped, so the line never implies work that did not happen.</p>
    <div class="act-panel">
      <div class="act-legend" id="act-legend">
        ${SERIES.map(
          (s) =>
            `<button type="button" class="act-key is-on" data-key="${s.key}">
              <i style="background:${s.colour}"></i>${s.label}</button>`,
        ).join('')}
      </div>
      <div class="act-chart" id="act-lines"><p class="muted">loading…</p></div>
      <div class="act-tip" id="act-tip" hidden></div>
    </div>

    <h2 id="skill-installs">Agent skill installs</h2>
    <p>Counted by the last line of the installer, after the files have landed. It sends no
    identifier, so read it as a floor on real installs rather than a headcount: anyone can call
    that endpoint, and nobody is being followed to find out whether they were the same person
    twice.</p>
    <div class="act-panel">
      <div class="act-chart" id="act-installs"><p class="muted">loading…</p></div>
    </div>

    <h2 id="how-fast">How fast a batch opens</h2>
    <p>Percentiles rather than an average. One slow batch drags an average somewhere no batch
    ever was, and the number worth knowing is the one most opens beat.</p>
    <div class="act-panel" id="act-latency"><p class="muted">loading…</p></div>

    <h2 id="the-board">What is being built</h2>
    <p>Pass a <code>tag</code> when you create a round or an auction. It is how you query your own
    later, and it puts your app on the board.</p>
    <pre class="doc-code"><code>body: JSON.stringify({ opens_in: 3600, tag: 'my-app' })</code></pre>
    <p class="dev-note">Tags are up to 32 characters of <code>a-z 0-9 : _ -</code>. They are labels
    rather than registered names, so read the board as a directory of what is being built here.</p>
    <div id="dev-board" class="dev-board"><p class="muted">loading…</p></div>

    <h2 id="not-counted">What this page does not count</h2>
    <p>There are no accounts on this network, which is the point of it, so there is no user count
    to show. Nothing on this page observes a reader: no visitor count, no session, no address, no
    agent string, no cookie. The numbers above are work the coordinator performed and had to
    record in order to perform it.</p>
    <p>Paid calls are the exception to all of that: an x402 payment settles on chain, so that
    number is not a floor or an estimate, it is a count of transactions anyone can go and check.
    See <a href="#/developers/x402">metered calls</a>.</p>
    <p>Two consequences worth stating plainly. Skill installs are a floor, for the reason given
    above. And sealed payload counts exclude the decoys the coordinator pads every batch with, so
    a quiet round does not appear busy; the decoy total is shown separately in the cards.</p>`,

  mount: (root) => {
    let days = 30;
    let latest: Activity | null = null;
    let timer: number | undefined;
    let stopped = false;
    const active = new Set<SeriesKey>(SERIES.map((s) => s.key));

    const el = <T extends Element>(sel: string): T | null => root.querySelector<T>(sel);

    const paintCards = (a: Activity): void => {
      const cards = el('#act-cards');
      if (!cards) return;
      const windowed = (k: keyof DayRow): number =>
        a.series.reduce((sum, d) => sum + (d[k] as number), 0);
      const items: [string, string, string, string][] = [
        ['rounds', nf.format(a.totals.rounds), `${nf.format(windowed('rounds'))} in ${days}d`, '#2563eb'],
        ['payloads sealed', nf.format(a.totals.sealed), `${nf.format(windowed('sealed'))} in ${days}d`, '#0ea5e9'],
        ['batches opened', nf.format(a.totals.batches), `${nf.format(windowed('opened'))} in ${days}d`, '#16a34a'],
        ['skill installs', nf.format(a.totals.skill_installs), `${nf.format(windowed('skill_installs'))} in ${days}d`, '#7c3aed'],
        ['median open', dur(a.open_ms.p50), `${nf.format(a.open_ms.samples)} opens timed`, '#0891b2'],
        ['x402 calls paid', nf.format(a.totals.paid_calls), `${nf.format(windowed('paid_calls'))} in ${days}d`, '#f59e0b'],
        ['decoys added', nf.format(a.totals.decoys), 'excluded from sealed', '#94a3b8'],
      ];
      cards.innerHTML = items
        .map(
          ([label, value, sub, colour]) => `
        <div class="act-card" style="--card:${colour}">
          <span>${esc(label)}</span>
          <strong>${esc(value)}</strong>
          <em>${esc(sub)}</em>
        </div>`,
        )
        .join('');
    };

    /** The crosshair readout. Bound once per repaint, off the chart element. */
    const bindHover = (host: HTMLElement, a: Activity): void => {
      const svg = host.querySelector('svg');
      const tip = el<HTMLElement>('#act-tip');
      const cross = svg?.querySelector<SVGLineElement>('.ch-cross');
      if (!svg || !tip) return;

      const move = (ev: PointerEvent): void => {
        const box = svg.getBoundingClientRect();
        const n = a.series.length;
        // Back out the viewBox scale rather than assuming pixels: the chart is
        // laid out in viewBox units and rendered at whatever width it got.
        const vx = ((ev.clientX - box.left) / box.width) * W;
        const span = (W - PAD.left - PAD.right) / Math.max(1, n - 1);
        const i = Math.max(0, Math.min(n - 1, Math.round((vx - PAD.left) / span)));
        const d = a.series[i];
        if (!d) return;
        if (cross) {
          const x = xAt(i, n);
          cross.setAttribute('x1', String(x));
          cross.setAttribute('x2', String(x));
          cross.style.opacity = '1';
        }
        for (const dot of svg.querySelectorAll<SVGCircleElement>('.ch-dot')) {
          dot.classList.toggle('is-on', dot.dataset.i === String(i));
        }
        tip.hidden = false;
        tip.innerHTML = `<strong>${esc(dayLabel(d.day))}</strong>${SERIES.filter((s) => active.has(s.key))
          .map(
            (s) =>
              `<span><i style="background:${s.colour}"></i>${s.label}<b>${nf.format(d[s.key])}</b></span>`,
          )
          .join('')}`;
        // Keep the card inside the panel at either edge.
        const panel = host.parentElement?.getBoundingClientRect();
        const left = panel ? ev.clientX - panel.left : 0;
        const half = tip.offsetWidth / 2;
        const limit = panel ? panel.width - half - 8 : 0;
        tip.style.left = `${Math.max(half + 8, Math.min(limit, left))}px`;
      };

      const leave = (): void => {
        tip.hidden = true;
        if (cross) cross.style.opacity = '0';
        for (const dot of svg.querySelectorAll('.ch-dot')) dot.classList.remove('is-on');
      };

      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerleave', leave);
    };

    const paint = (a: Activity): void => {
      latest = a;
      paintCards(a);

      const asof = el('#act-asof');
      if (asof) {
        asof.textContent = `last ${a.days} days, as of ${new Date(a.as_of * 1000).toLocaleTimeString()}`;
      }

      const lines = el<HTMLElement>('#act-lines');
      if (lines) {
        lines.innerHTML = active.size === 0
          ? '<p class="muted">no series selected.</p>'
          : lineChart(a.series, active);
        if (active.size > 0) bindHover(lines, a);
      }

      const installs = el('#act-installs');
      if (installs) installs.innerHTML = barChart(a.series);

      const lat = el('#act-latency');
      if (lat) lat.innerHTML = latency(a.open_ms);

      const board = el('#dev-board');
      if (board) {
        if (a.tags.length === 0) {
          board.innerHTML = '<p class="muted">nobody has tagged a round yet. be first.</p>';
        } else {
          const top = Math.max(1, ...a.tags.map((t) => t.rounds));
          const rows = a.tags
            .map((t, i) => {
              const share = Math.max(2, Math.round((t.rounds / top) * 100));
              const live = t.recent > 0;
              return `
              <li class="dev-rank${live ? ' is-live' : ''}">
                <span class="dev-rank-n mono">${i + 1}</span>
                <span class="dev-rank-tag mono">${esc(t.tag)}${live ? '<span class="dev-live">active</span>' : ''}</span>
                <span class="dev-rank-bar" aria-hidden="true"><i style="width:${share}%"></i></span>
                <span class="dev-rank-num">${nf.format(t.rounds)}</span>
                <span class="dev-rank-num">${nf.format(t.recent)}</span>
                <span class="dev-rank-when">${esc(ago(t.last_seen, a.as_of))}</span>
              </li>`;
            })
            .join('');
          board.innerHTML = `
            <ol class="dev-ranks">
              <li class="dev-rank dev-rank-head">
                <span class="dev-rank-n"></span><span class="dev-rank-tag">tag</span>
                <span class="dev-rank-bar"></span>
                <span class="dev-rank-num">rounds</span><span class="dev-rank-num">in ${a.days}d</span>
                <span class="dev-rank-when">last</span>
              </li>${rows}
            </ol>`;
        }
      }
    };

    /** An ellipsis reads as still loading when it means gave up. */
    const unavailable = (): void => {
      if (latest) return;
      for (const id of ['#act-lines', '#act-installs', '#act-latency', '#dev-board']) {
        const node = el(id);
        if (node && node.textContent?.trim() === 'loading…') {
          node.innerHTML = '<p class="muted">the network numbers are not reachable from here '
            + 'right now. they will fill in when they are.</p>';
        }
      }
      const asof = el('#act-asof');
      if (asof && asof.textContent === 'loading…') asof.textContent = 'not reachable';
    };

    const poll = async (): Promise<void> => {
      const want = days;
      try {
        const res = await fetch(`${base}/v0/activity?days=${want}`, {
          headers: { accept: 'application/json' },
        });
        // A dev server with no coordinator behind it answers with the app shell,
        // so a 200 is not on its own proof of an answer.
        if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) {
          throw new Error(`activity unavailable (${res.status})`);
        }
        const body = (await res.json()) as Activity;
        if (!Array.isArray(body?.series)) throw new Error('unexpected shape');
        // A slow request for a range the reader has already moved off would
        // repaint the chart they just left.
        if (want === days) paint(body);
      } catch {
        unavailable();
      }
      if (!stopped) timer = window.setTimeout(poll, 15_000);
    };
    void poll();

    const refetch = (): void => {
      if (timer) window.clearTimeout(timer);
      void poll();
    };

    root.querySelector('.act-range')?.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLElement>('.act-range-btn');
      if (!btn?.dataset.days) return;
      days = Number(btn.dataset.days);
      for (const b of root.querySelectorAll('.act-range-btn')) {
        b.classList.toggle('is-on', b === btn);
      }
      latest = null;
      refetch();
    });

    root.querySelector('#act-legend')?.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLElement>('.act-key');
      const key = btn?.dataset.key as SeriesKey | undefined;
      if (!key) return;
      if (active.has(key)) active.delete(key);
      else active.add(key);
      btn?.classList.toggle('is-on', active.has(key));
      if (latest) paint(latest);
    });

    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  },
};
