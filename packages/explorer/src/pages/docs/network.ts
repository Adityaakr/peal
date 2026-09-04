/**
 * The activity dashboard: what the network has actually done.
 *
 * Everything here is work the coordinator performed and had to record in order
 * to perform it, plus two counters for things that leave no other trace. There
 * is no visitor count, no session, no cookie and no stored address, because
 * there are no accounts on this network and nothing here observes a reader.
 *
 * There is deliberately no geography here. The only signal available without
 * handling visitor addresses was the edge that served the request, and that
 * reports where this server runs rather than where anybody is, so it was taken
 * out rather than left up looking like a finding.
 */
import type { DocsPage } from '../../docs';
import { base } from './runner';
import { esc } from '../../util';
import {
  PALETTE,
  barList,
  donut,
  histogram,
  niceMax,
  sparkline,
  ticksFor,
  type BarRow,
  type Slice,
} from './charts';

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
  calls: number;
}

interface Activity {
  days: number;
  as_of: number;
  calls: number;
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
  timings?: number[];
  tags: TagRow[];
  endpoints: { family: string; calls: number; errors: number }[];
}

const nf = new Intl.NumberFormat();
const RANGES = [7, 30, 90] as const;

const SERIES = [
  { key: 'rounds', label: 'rounds', colour: PALETTE.rounds },
  { key: 'sealed', label: 'sealed', colour: PALETTE.sealed },
  { key: 'opened', label: 'opened', colour: PALETTE.opened },
  { key: 'calls', label: 'api calls', colour: PALETTE.calls },
] as const;

type SeriesKey = (typeof SERIES)[number]['key'];

function ago(unix: number, now: number): string {
  const secs = Math.max(0, now - unix);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}

function dur(ms: number | null): string {
  if (ms === null) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Parsed as UTC, which is what the server counted in. Reading it as local time
 *  slides every label by a day for anyone west of Greenwich. */
function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${d.getUTCDate()} ${d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`;
}

// ------------------------------------------------------------ main chart ---

const W = 1000;
const H = 250;
const PAD = { top: 16, right: 12, bottom: 26, left: 46 };

const xAt = (i: number, n: number): number =>
  n <= 1 ? PAD.left + (W - PAD.left - PAD.right) / 2 : PAD.left + (i / (n - 1)) * (W - PAD.left - PAD.right);
const yAt = (v: number, max: number): number => H - PAD.bottom - (v / max) * (H - PAD.top - PAD.bottom);

function lineChart(series: DayRow[], active: Set<SeriesKey>): string {
  const n = series.length;
  const visible = SERIES.filter((s) => active.has(s.key));
  const max = niceMax(Math.max(1, ...visible.flatMap((s) => series.map((d) => d[s.key]))));

  const grid = ticksFor(max)
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
      aria-label="rounds, payloads sealed, batches opened and api calls per day">
      ${grid}${paths}${dots}${xticks}
      <line class="ch-cross" x1="0" y1="${PAD.top}" x2="0" y2="${H - PAD.bottom}" style="opacity:0"/>
    </svg>`;
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

    <div class="act-cards" id="act-cards" aria-label="headline numbers"></div>

    <h2 id="over-time">Over time</h2>
    <p>Rounds created, payloads sealed into them, batches opened, and API calls, per day. Quiet
    days are drawn as quiet days rather than skipped, so the line never implies work that did not
    happen.</p>
    <div class="act-panel">
      <div class="act-legend" id="act-legend">
        ${SERIES.map(
          (s) =>
            `<button type="button" class="act-key${s.key === 'calls' ? '' : ' is-on'}" data-key="${s.key}">
              <i style="background:${s.colour}"></i>${s.label}</button>`,
        ).join('')}
      </div>
      <div class="act-chart" id="act-lines"><p class="muted">loading…</p></div>
      <div class="act-tip" id="act-tip" hidden></div>
    </div>

    <div class="act-grid">
      <section class="act-panel">
        <h3>What it is used for</h3>
        <p class="act-panel-note">Share of rounds by tag.</p>
        <div id="act-donut"><p class="muted">loading…</p></div>
      </section>

      <section class="act-panel">
        <h3>Which parts of the API</h3>
        <p class="act-panel-note">Calls by family, with failures counted apart.</p>
        <div id="act-endpoints"><p class="muted">loading…</p></div>
      </section>
    </div>

    <h2 id="api-calls">API calls</h2>
    <p>Every request to <code>/v0</code> and <code>/v1</code>, counted by family. The dashboard's
    own polling is excluded: it runs every fifteen seconds per open tab, and counting it would
    make this page the busiest thing on the chart it is drawing.</p>
    <div class="act-panel">
      <div class="act-total" id="act-calls-total"></div>
      <div class="act-chart" id="act-calls-chart"><p class="muted">loading…</p></div>
    </div>

    <h2 id="skill-installs">Agent skill installs</h2>
    <p>Counted by the last line of the installer, after the files have landed. It sends no
    identifier, so read it as a floor on real installs rather than a headcount: anyone can call
    that endpoint, and nobody is being followed to find out whether they were the same person
    twice.</p>
    <div class="act-panel">
      <div class="act-total" id="act-install-total"></div>
      <div class="act-chart" id="act-installs"><p class="muted">loading…</p></div>
    </div>

    <h2 id="how-fast">How fast a batch opens</h2>
    <p>Percentiles rather than an average. One slow batch drags an average somewhere no batch ever
    was, and the number worth knowing is the one most opens beat. The distribution underneath says
    whether that average would have been hiding two different behaviours.</p>
    <div class="act-panel" id="act-latency"><p class="muted">loading…</p></div>

    <h2 id="the-board">What is being built</h2>
    <p>Pass a <code>tag</code> when you create a round or an auction. It is how you query your own
    later, and it puts your app on the board.</p>
    <pre class="doc-code"><code>body: JSON.stringify({ opens_in: 3600, tag: 'my-app' })</code></pre>
    <div id="dev-board" class="dev-board"><p class="muted">loading…</p></div>

    <h2 id="not-counted">What this page does not count</h2>
    <p>There are no accounts on this network, which is the point of it, so there is no user count
    to show. Nothing here observes a reader: no visitor count, no session, no cookie, no stored
    address. The numbers above are work the coordinator performed and had to record in order to
    perform it.</p>
    <p><strong>There is no map, and that is deliberate.</strong> Placing a caller means
    resolving their address against a geolocation database, which would have this coordinator
    handling visitor addresses in order to draw a picture. On a product whose whole claim is that
    it cannot read what you send it, that is not a trade worth making. A panel was built on the
    one signal that needed no address, the serving edge, and it turned out to report where this
    server runs rather than where anybody is, so it was removed rather than left up looking like
    a finding.</p>
    <p>Two consequences worth stating plainly. Skill installs are a floor, for the reason given
    above. And sealed payload counts exclude the decoys every batch is padded with, so a quiet
    round does not appear busy.</p>
    <p>Paid calls are the exception to all of it: an x402 payment settles on chain, so that number
    is not a floor or an estimate, it is a count of transactions anyone can check. See
    <a href="#/developers/x402">metered calls</a>.</p>`,

  mount: (root) => {
    let days = 30;
    let latest: Activity | null = null;
    let timer: number | undefined;
    let stopped = false;
    const active = new Set<SeriesKey>(['rounds', 'sealed', 'opened']);

    const el = <T extends Element>(sel: string): T | null => root.querySelector<T>(sel);
    const windowed = (a: Activity, k: keyof DayRow): number =>
      a.series.reduce((sum, d) => sum + (d[k] as number), 0);

    const paintCards = (a: Activity): void => {
      const cards = el('#act-cards');
      if (!cards) return;
      const items: {
        label: string;
        value: string;
        sub: string;
        colour: string;
        series: number[];
      }[] = [
        {
          label: 'skill installs',
          value: nf.format(a.totals.skill_installs),
          sub: `${nf.format(windowed(a, 'skill_installs'))} in ${days}d`,
          colour: PALETTE.installs,
          series: a.series.map((d) => d.skill_installs),
        },
        {
          label: 'api calls',
          value: nf.format(a.calls),
          sub: `in the last ${days}d`,
          colour: PALETTE.calls,
          series: a.series.map((d) => d.calls),
        },
        {
          label: 'rounds',
          value: nf.format(a.totals.rounds),
          sub: `${nf.format(windowed(a, 'rounds'))} in ${days}d`,
          colour: PALETTE.rounds,
          series: a.series.map((d) => d.rounds),
        },
        {
          label: 'payloads sealed',
          value: nf.format(a.totals.sealed),
          sub: `${nf.format(windowed(a, 'sealed'))} in ${days}d`,
          colour: PALETTE.sealed,
          series: a.series.map((d) => d.sealed),
        },
        {
          label: 'x402 calls paid',
          value: nf.format(a.totals.paid_calls),
          sub: `${nf.format(windowed(a, 'paid_calls'))} in ${days}d`,
          colour: PALETTE.paid,
          series: a.series.map((d) => d.paid_calls),
        },
      ];
      cards.innerHTML = items
        .map(
          (it, i) => `
        <div class="act-card" style="--card:${it.colour}">
          <span>${esc(it.label)}</span>
          <strong>${esc(it.value)}</strong>
          <em>${esc(it.sub)}</em>
          ${sparkline(it.series, it.colour, `c${i}`)}
        </div>`,
        )
        .join('');
    };

    const bindHover = (host: HTMLElement, a: Activity): void => {
      const svg = host.querySelector('svg');
      const tip = el<HTMLElement>('#act-tip');
      const cross = svg?.querySelector<SVGLineElement>('.ch-cross');
      if (!svg || !tip) return;

      const move = (ev: PointerEvent): void => {
        const box = svg.getBoundingClientRect();
        const n = a.series.length;
        // Back out the viewBox scale: the chart is laid out in viewBox units
        // and rendered at whatever width the panel gave it.
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

    /** Installs as bars: a count of discrete events. Drawn as a line it would
     *  imply a value between Tuesday and Wednesday. */
    const installBars = (a: Activity): string => {
      const n = a.series.length;
      const max = niceMax(Math.max(1, ...a.series.map((d) => d.skill_installs)));
      const inner = W - PAD.left - PAD.right;
      const slot = inner / n;
      const bw = Math.max(2, Math.min(28, slot * 0.62));
      const grid = ticksFor(max, 2)
        .map((v) => {
          const y = yAt(v, max);
          return `<line class="ch-grid" x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}"/>
            <text class="ch-ytick" x="${PAD.left - 10}" y="${y + 4}">${nf.format(v)}</text>`;
        })
        .join('');
      const bars = a.series
        .map((d, i) => {
          const x = PAD.left + slot * i + (slot - bw) / 2;
          const bh = Math.max(d.skill_installs > 0 ? 2 : 0, H - PAD.bottom - yAt(d.skill_installs, max));
          return `<rect class="ch-bar" x="${x.toFixed(1)}" y="${(H - PAD.bottom - bh).toFixed(1)}"
            width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2"><title>${esc(dayLabel(d.day))}: ${d.skill_installs}</title></rect>`;
        })
        .join('');
      const every = Math.max(1, Math.ceil(n / 6));
      const xticks = a.series
        .map((d, i) =>
          (n - 1 - i) % every === 0
            ? `<text class="ch-xtick" x="${(PAD.left + slot * i + slot / 2).toFixed(1)}" y="${H - 8}">${esc(dayLabel(d.day))}</text>`
            : '',
        )
        .join('');
      return `<svg class="ch ch-bars" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="agent skill installs per day">${grid}${bars}${xticks}</svg>`;
    };

    /**
     * Render one panel, and let it fail alone.
     *
     * paint() used to be one straight run, so a single panel throwing left
     * every panel after it showing "loading" for ever. That happened for real:
     * the server stopped sending a field, and browsers still holding the
     * previous bundle read it, threw, and rendered a page of loading text with
     * no error anywhere. A dashboard that cannot draw one number should still
     * draw the other nine.
     */
    const panel = (id: string, draw: () => void): void => {
      try {
        draw();
      } catch (err) {
        const node = el<HTMLElement>(id);
        if (node) {
          node.innerHTML = '<p class="muted">this panel could not be drawn. '
            + 'the rest of the page is unaffected.</p>';
        }
        // Left in the console on purpose: silent is how the original bug
        // survived, and this is a page whose whole point is being checkable.
        console.error(`activity: ${id} failed to render`, err);
      }
    };

    const paint = (a: Activity): void => {
      latest = a;
      // A field the server has stopped sending, or has not started sending
      // yet, must not be able to take the page down.
      a.series ??= [];
      a.tags ??= [];
      a.endpoints ??= [];
      panel('#act-cards', () => paintCards(a));

      panel('#act-asof', () => {
        const asof = el('#act-asof');
        if (asof) {
          asof.textContent = `last ${a.days} days, as of ${new Date(a.as_of * 1000).toLocaleTimeString()}`;
        }
      });

      panel('#act-lines', () => {
        const lines = el<HTMLElement>('#act-lines');
        if (lines) {
          lines.innerHTML =
            active.size === 0 ? '<p class="muted">no series selected.</p>' : lineChart(a.series, active);
          if (active.size > 0) bindHover(lines, a);
        }
      });

      panel('#act-calls-chart', () => {
        const failures = a.endpoints.reduce((sum, e) => sum + e.errors, 0);
        const busiest = a.endpoints[0];
        const callsTotal = el('#act-calls-total');
        if (callsTotal) {
          callsTotal.innerHTML = `
            <strong>${nf.format(a.calls)}</strong>
            <span>call${a.calls === 1 ? '' : 's'} in the last ${a.days} days</span>
            <em>${
              failures > 0
                ? `${nf.format(failures)} failed`
                : 'none failed'
            }${busiest ? ` · busiest ${esc(busiest.family)}` : ''}</em>`;
        }
        const callsChart = el<HTMLElement>('#act-calls-chart');
        if (callsChart) {
          const any = a.series.some((d) => d.calls > 0);
          // Reuses the same chart as Over time with one series selected, so
          // the two cannot end up drawing the same numbers differently.
          callsChart.innerHTML = any
            ? lineChart(a.series, new Set<SeriesKey>(['calls']))
            : `<p class="act-empty">No calls counted in this window.
               <span>Counting started when this page shipped. Anything before then is not
               in here.</span></p>`;
        }
      });

      panel('#act-installs', () => {
        // The running total, which is the number people actually want, above a
        // chart that only ever shows the selected window. Without it the section
        // could read "none" while the real count was climbing, which is exactly
        // what it did.
        const total = el('#act-install-total');
        const inWindow = windowed(a, 'skill_installs');
        if (total) {
          total.innerHTML = `
            <strong>${nf.format(a.totals.skill_installs)}</strong>
            <span>install${a.totals.skill_installs === 1 ? '' : 's'} all time</span>
            <em>${nf.format(inWindow)} in the last ${a.days} days</em>`;
        }

        const installs = el('#act-installs');
        if (installs) {
          // An all-zero bar chart is an empty white box, which reads as broken
          // rather than as nothing having happened yet. Say which it is, and say
          // it differently depending on whether the total is zero too.
          installs.innerHTML = inWindow > 0
            ? installBars(a)
            : a.totals.skill_installs > 0
              ? `<p class="act-empty">None in the last ${a.days} days.
                 <span>The running total above is every install ever counted. Widen the range
                 above to find them.</span></p>`
              : `<p class="act-empty">Nothing counted yet.
                 <span>Run <code>curl -fsSL https://peal.network/skill/install.sh | sh</code>
                 and this fills in within about fifteen seconds.</span></p>`;
        }
      });

      panel('#act-donut', () => {
        // ---- donut: what the network is used for ----
        const donutHost = el('#act-donut');
        if (donutHost) {
          const wheel = [
            PALETTE.rounds, PALETTE.sealed, PALETTE.opened, PALETTE.installs,
            PALETTE.calls, PALETTE.paid, PALETTE.muted,
          ];
          const top = a.tags.slice(0, 6);
          const rest = a.tags.slice(6).reduce((sum, t) => sum + t.rounds, 0);
          const slices: Slice[] = top.map((t, i) => ({
            label: t.tag,
            value: t.rounds,
            colour: wheel[i] ?? PALETTE.muted,
          }));
          if (rest > 0) slices.push({ label: 'everything else', value: rest, colour: PALETTE.muted });
          donutHost.innerHTML = donut(slices, 'rounds', nf.format(a.totals.rounds));
        }
      });

      panel('#act-endpoints', () => {
        // ---- endpoints ----
        const epHost = el('#act-endpoints');
        if (epHost) {
          const rows: BarRow[] = a.endpoints.map((e) => ({
            label: e.family,
            value: e.calls,
            sub: e.errors > 0 ? `${nf.format(e.errors)} failed` : undefined,
            colour: e.errors > 0 && e.errors / Math.max(1, e.calls) > 0.25 ? '#dc2626' : PALETTE.rounds,
          }));
          epHost.innerHTML = rows.length
            ? barList(rows, ' calls')
            : '<p class="muted">no calls counted in this window yet.</p>';
        }
      });

      panel('#act-latency', () => {
        // ---- latency ----
        const lat = el('#act-latency');
        if (lat) {
          const o = a.open_ms;
          if (o.samples === 0) {
            lat.innerHTML = '<p class="muted">no batch has been opened yet, so there is nothing to time.</p>';
          } else {
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
            lat.innerHTML = `<ul class="lat">${rows}</ul>
              ${a.timings?.length ? histogram(a.timings) : ''}
              <p class="field-hint">Measured across ${nf.format(o.samples)} opened
              batch${o.samples === 1 ? '' : 'es'}, from the moment the batch froze to the moment its
              payloads were readable. It covers the committee's work, not the wait for the deadline
              you set.</p>`;
          }
        }
      });

      panel('#dev-board', () => {
        // ---- the board ----
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
                  <span class="dev-rank-tag mono"><span>${esc(t.tag)}</span>${live ? '<span class="dev-live">active</span>' : ''}</span>
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
      });
    };

    /** An ellipsis reads as still loading when it means gave up. */
    const unavailable = (): void => {
      if (latest) return;
      for (const id of ['#act-lines', '#act-installs', '#act-latency', '#dev-board',
                        '#act-donut', '#act-endpoints', '#act-calls-chart']) {
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
      for (const b of root.querySelectorAll('.act-range-btn')) b.classList.toggle('is-on', b === btn);
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
