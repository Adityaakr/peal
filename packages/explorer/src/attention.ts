/** Attention helpers for long reveals: tab title + favicon state, calendar
 * exports, reveal notifications, and a localStorage list of watched seals.
 * All client-side; the coordinator stays pull-only. */

const BASE_TITLE = document.title;

export function emojiIcon(emoji: string): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="32" y="52" font-size="52" text-anchor="middle">${emoji}</text></svg>`,
  )}`;
}

let faviconEl: HTMLLinkElement | null = null;
let baseFavicon: string | null = null;

/** Put live state in the tab: "⏳ 2h 14m · Peal" + a lock/unlock favicon.
 * Pass null to restore the defaults (the Peal leaf). */
export function setTabState(title: string | null, emoji?: string): void {
  document.title = title ? `${title} · Peal` : BASE_TITLE;
  if (!faviconEl) {
    faviconEl = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!faviconEl) {
      faviconEl = document.createElement('link');
      faviconEl.rel = 'icon';
      document.head.appendChild(faviconEl);
    }
    baseFavicon = faviconEl.href || null;
  }
  if (title === null && emoji === undefined) {
    if (baseFavicon) faviconEl.href = baseFavicon;
    return;
  }
  faviconEl.href = emojiIcon(emoji ?? '🔒');
}

/** Compact countdown for tab titles and menu rows: drops seconds past 1h. */
export function fmtCountdownShort(secs: number): string {
  if (secs <= 0) return 'opening';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${secs % 60}s`;
  return `${secs}s`;
}

// -- calendar ----------------------------------------------------------------

/**
 * A seal link with its share key removed.
 *
 * A private seal's key is the last segment of the fragment, and it is the only
 * thing that decrypts the payload. The whole reason it rides in the fragment is
 * that a fragment is never sent to a server. A calendar reminder breaks that on
 * both routes: `gcalUrl` hands its argument to calendar.google.com inside a
 * query parameter, and the .ics from `icsHref` lands in whatever calendar the
 * reader syncs, which for most people is a hosted one.
 *
 * So the reminder carries the link without the key. It still opens the page at
 * the right moment; the reader keeps the original link to read the content.
 *
 * The key is matched by identity rather than by shape, because a bare seal link
 * ends in a 64 character hash that a shape rule would strip just as happily.
 */
export function withoutShareKey(href: string, shareKey?: string): string {
  if (!shareKey) return href;
  const url = new URL(href);
  const tail = `/${shareKey}`;
  if (!url.hash.endsWith(tail)) return href;
  url.hash = url.hash.slice(0, -tail.length);
  return url.toString();
}

function icsStamp(unixSecs: number): string {
  return new Date(unixSecs * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** A data: href for an .ics event at the fire time, with a display alarm.
 * Use as <a href=... download="peal-seal.ics">. */
export function icsHref(opts: {
  conditionId: string;
  firesAt: number;
  url: string;
  /** Passed so this function can drop it, not so it can be written down. */
  shareKey?: string;
}): string {
  const url = withoutShareKey(opts.url, opts.shareKey);
  const start = icsStamp(opts.firesAt);
  const end = icsStamp(opts.firesAt + 5 * 60);
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Peal//seal//EN',
    'BEGIN:VEVENT',
    `UID:peal-${opts.conditionId}@peal.network`,
    `DTSTAMP:${icsStamp(Math.floor(Date.now() / 1000))}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    'SUMMARY:a seal opens',
    `DESCRIPTION:the sealed content unlocks. open the link:\\n${url}`,
    `URL:${url}`,
    'BEGIN:VALARM',
    'TRIGGER:PT0S',
    'ACTION:DISPLAY',
    'DESCRIPTION:a seal opens now',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
}

/** Google Calendar "add event" URL for the fire time. */
export function gcalUrl(opts: {
  firesAt: number;
  url: string;
  /** Passed so this function can drop it, not so it can be written down. */
  shareKey?: string;
}): string {
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: 'a seal opens',
    dates: `${icsStamp(opts.firesAt)}/${icsStamp(opts.firesAt + 5 * 60)}`,
    details: `the sealed content unlocks. open the link: ${withoutShareKey(opts.url, opts.shareKey)}`,
  });
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

// -- notifications -----------------------------------------------------------

export function notifSupported(): boolean {
  return 'Notification' in window;
}

export function notifGranted(): boolean {
  return notifSupported() && Notification.permission === 'granted';
}

/** Ask for permission (must be called from a user gesture). */
export async function enableNotify(): Promise<boolean> {
  if (!notifSupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

export function notifyReveal(body: string): void {
  if (!notifGranted()) return;
  try {
    const n = new Notification('your seal opened', { body, icon: emojiIcon('🔓') });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // some platforms need a service worker for constructor notifications
  }
}

// -- watched seals (localStorage) ---------------------------------------------

export interface WatchedSeal {
  conditionId: string;
  ctHash: string;
  firesAt: number | null;
  role: 'sent' | 'received';
  label: string;
  addedAt: number;
  revealed?: boolean;
}

const STORE_KEY = 'bte:seals';
const STORE_MAX = 50;

export function listSeals(): WatchedSeal[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WatchedSeal[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSeals(seals: WatchedSeal[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(seals.slice(0, STORE_MAX)));
  } catch {
    // storage full or blocked; watching is best-effort
  }
}

export function rememberSeal(seal: Omit<WatchedSeal, 'addedAt'>): void {
  const seals = listSeals();
  const existing = seals.find(
    (s) => s.conditionId === seal.conditionId && s.ctHash === seal.ctHash,
  );
  if (existing) {
    existing.firesAt = seal.firesAt ?? existing.firesAt;
    existing.revealed = seal.revealed ?? existing.revealed;
  } else {
    seals.unshift({ ...seal, addedAt: Math.floor(Date.now() / 1000) });
  }
  writeSeals(seals);
}

export function markSealRevealed(conditionId: string): void {
  const seals = listSeals();
  let touched = false;
  for (const s of seals) {
    if (s.conditionId === conditionId && !s.revealed) {
      s.revealed = true;
      touched = true;
    }
  }
  if (touched) writeSeals(seals);
}

export function forgetSeal(conditionId: string, ctHash: string): void {
  writeSeals(listSeals().filter((s) => !(s.conditionId === conditionId && s.ctHash === ctHash)));
}
