/**
 * The chart primitives for the activity dashboard.
 *
 * Hand written SVG, no dependency. At this size a charting library would be
 * larger than the page it draws on, and this way every chart reads the site's
 * own palette rather than a theme that nearly matches.
 *
 * Everything here takes numbers and returns a string. Nothing touches the DOM,
 * nothing fetches, and nothing holds state, so each one can be checked by
 * looking at its output.
 */
import { esc } from '../../util';

export const PALETTE = {
  rounds: '#2563eb',
  sealed: '#0ea5e9',
  opened: '#16a34a',
  calls: '#f59e0b',
  installs: '#7c3aed',
  paid: '#e11d48',
  muted: '#94a3b8',
} as const;

/**
 * A ceiling a person would have picked.
 *
 * The steps are deliberately finer than the usual 1/2/5/10. With only those,
 * a series peaking at 54 gets an axis to 100 and spends half the chart empty,
 * which is how the first version of this page drew a month of real traffic as
 * a flat line along the floor.
 */
export function niceMax(value: number): number {
  if (value <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const candidate = step * mag;
    if (candidate >= value) return candidate;
  }
  return 10 * mag;
}

/** Round numbers for gridlines, deduplicated: at small maxima several ticks
 *  land on the same integer and drawing them stacks identical labels. */
export function ticksFor(max: number, count = 4): number[] {
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(Math.round((max * i) / count));
  return [...new Set(out)];
}

// ------------------------------------------------------------- sparklines --

/**
 * The small chart inside a stat card. No axes, no labels: it exists to answer
 * "which way is this going", and anything else on it competes with the number
 * it sits beside.
 */
export function sparkline(values: number[], colour: string, id: string): string {
  const w = 240;
  const h = 48;
  if (values.length === 0) return '';
  const max = Math.max(1, ...values);
  const n = values.length;
  const x = (i: number): number => (n === 1 ? w / 2 : (i / (n - 1)) * w);
  // A flat zero series would draw along the very bottom edge and get clipped by
  // the card, so the floor sits a little above it.
  const y = (v: number): number => h - 3 - (v / max) * (h - 8);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${pts.join('L')}`;
  const area = `${line}L${w},${h}L0,${h}Z`;
  const last = values[values.length - 1] ?? 0;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="sg-${esc(id)}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${colour}" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="${colour}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#sg-${esc(id)})"/>
      <path d="${line}" fill="none" stroke="${colour}" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      <circle cx="${x(n - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.5" fill="${colour}"/>
    </svg>`;
}

// ------------------------------------------------------------------ donut --

export interface Slice {
  label: string;
  value: number;
  colour: string;
}

/**
 * Share of a whole, as a ring.
 *
 * Drawn with stroke-dasharray on circles rather than arc paths: one circle per
 * slice, each dashed to its own share and rotated past the ones before it. No
 * arc maths, and no chance of the seam artefacts that hand rolled arcs produce
 * at exactly 0 and 100 percent.
 */
export function donut(slices: Slice[], centreLabel: string, centreValue: string): string {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const size = 180;
  const r = 66;
  const c = 2 * Math.PI * r;
  if (total === 0) {
    return `<div class="donut-empty muted">nothing yet</div>`;
  }
  let offset = 0;
  const rings = slices
    .filter((s) => s.value > 0)
    .map((s) => {
      const share = s.value / total;
      const dash = share * c;
      // -90deg puts the first slice at twelve o'clock, where a reader starts.
      const rot = -90 + (offset / total) * 360;
      offset += s.value;
      return `<circle class="donut-arc" cx="${size / 2}" cy="${size / 2}" r="${r}"
        fill="none" stroke="${s.colour}" stroke-width="20"
        stroke-dasharray="${dash.toFixed(2)} ${(c - dash).toFixed(2)}"
        transform="rotate(${rot.toFixed(2)} ${size / 2} ${size / 2})"
        stroke-linecap="butt"><title>${esc(s.label)}: ${s.value}</title></circle>`;
    })
    .join('');

  const legend = slices
    .filter((s) => s.value > 0)
    .map(
      (s) => `<li><i style="background:${s.colour}"></i>
        <span>${esc(s.label)}</span>
        <b>${Math.round((s.value / total) * 100)}%</b></li>`,
    )
    .join('');

  return `<div class="donut-wrap">
      <svg class="donut" viewBox="0 0 ${size} ${size}" role="img"
        aria-label="${esc(centreLabel)}: ${esc(centreValue)}">
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
          stroke="var(--border)" stroke-width="20"/>
        ${rings}
        <text class="donut-v" x="${size / 2}" y="${size / 2 - 2}">${esc(centreValue)}</text>
        <text class="donut-k" x="${size / 2}" y="${size / 2 + 16}">${esc(centreLabel)}</text>
      </svg>
      <ul class="donut-legend">${legend}</ul>
    </div>`;
}

// -------------------------------------------------------------- bar lists --

export interface BarRow {
  label: string;
  value: number;
  sub?: string;
  colour?: string;
}

/** A ranked list with the bar as the comparison. Used for regions and for the
 *  endpoint breakdown, which are the same question asked of different keys. */
export function barList(rows: BarRow[], unit: string): string {
  if (rows.length === 0) return '<p class="muted">nothing yet</p>';
  const top = Math.max(1, ...rows.map((r) => r.value));
  return `<ul class="barlist">${rows
    .map(
      (r) => `<li>
      <span class="barlist-label">${esc(r.label)}${r.sub ? `<em>${esc(r.sub)}</em>` : ''}</span>
      <span class="barlist-track"><i style="width:${Math.max(2, (r.value / top) * 100).toFixed(1)}%;
        background:${r.colour ?? PALETTE.rounds}"></i></span>
      <span class="barlist-value">${r.value.toLocaleString()}<em>${esc(unit)}</em></span>
    </li>`,
    )
    .join('')}</ul>`;
}

// ------------------------------------------------------------- histogram ---

/**
 * How long opening takes, as a distribution rather than three numbers.
 *
 * Percentiles say where the middle and the tail are. A histogram says whether
 * the shape is one hump or two, and two humps usually means two different
 * things are being measured.
 */
export function histogram(samples: number[], bins = 18): string {
  if (samples.length === 0) {
    return '<p class="muted">no batch has been opened yet, so there is nothing to time.</p>';
  }
  const lo = Math.min(...samples);
  const hi = Math.max(...samples);
  const w = 1000;
  const h = 190;
  const pad = { top: 12, right: 10, bottom: 26, left: 40 };
  // A single distinct value has no range to bin across; show it as one bar
  // rather than dividing by zero.
  const span = hi - lo || 1;
  const counts = new Array<number>(bins).fill(0);
  for (const v of samples) {
    const i = Math.min(bins - 1, Math.floor(((v - lo) / span) * bins));
    counts[i] = (counts[i] ?? 0) + 1;
  }
  const peak = Math.max(1, ...counts);
  const inner = w - pad.left - pad.right;
  const slot = inner / bins;
  const bars = counts
    .map((n, i) => {
      const bh = (n / peak) * (h - pad.top - pad.bottom);
      const x = pad.left + slot * i + slot * 0.12;
      return `<rect class="hist-bar" x="${x.toFixed(1)}" y="${(h - pad.bottom - bh).toFixed(1)}"
        width="${(slot * 0.76).toFixed(1)}" height="${bh.toFixed(1)}" rx="2">
        <title>${n} batch${n === 1 ? '' : 'es'}</title></rect>`;
    })
    .join('');
  const label = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
  return `<svg class="ch hist" viewBox="0 0 ${w} ${h}" role="img"
      aria-label="distribution of how long a batch takes to open">
      <line class="ch-grid" x1="${pad.left}" y1="${h - pad.bottom}" x2="${w - pad.right}"
        y2="${h - pad.bottom}"/>
      ${bars}
      <text class="ch-xtick" x="${pad.left}" y="${h - 8}" style="text-anchor:start">${esc(label(lo))}</text>
      <text class="ch-xtick" x="${w - pad.right}" y="${h - 8}" style="text-anchor:end">${esc(label(hi))}</text>
      <text class="ch-ytick" x="${pad.left - 8}" y="${pad.top + 10}">${peak}</text>
    </svg>`;
}
