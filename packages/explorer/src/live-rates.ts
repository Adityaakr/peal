/** Where the exchange rates come from.
 *
 * open.er-api.com: no key, CORS open, 160-odd currencies including every one
 * the auction form offers, republished once a day. Verified against the live
 * endpoint rather than assumed.
 *
 * DAILY, NOT LIVE. The provider recomputes at about 00:00 UTC, so a rate here
 * is a daily reference rate and the interface says so. Calling a once-a-day
 * number "live" would be the sort of small lie that makes everything else on
 * the page less believable.
 *
 * Nothing here may block a bid. If the rates cannot be fetched, the bid form
 * offers the auction's own currency and nothing else, which is exactly how it
 * behaved before any of this existed.
 */
import type { RateTable } from 'peal-live';

const ENDPOINT = 'https://open.er-api.com/v6/latest/USD';
const CACHE_KEY = 'peal-rates-usd-v1';
/** Refetch after this long. Well inside the daily republish, so a bidder is
 * never looking at yesterday's number because of our own cache. */
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;

interface Cached {
  table: RateTable;
  fetchedAt: number;
}

let inFlight: Promise<RateTable | null> | null = null;

function read(): Cached | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cached;
    // Shape-checked because it comes back from storage a user can edit, and a
    // rates table with a missing base would price bids wrong rather than fail.
    if (typeof parsed?.table?.base !== 'string') return null;
    if (typeof parsed.table.rates?.USD !== 'number') return null;
    if (typeof parsed.fetchedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The cached table, without any network call. Null when there is none.
 *
 * Separate from `rates()` so a page can render the form immediately with
 * whatever it already has and fill in the rest when the fetch lands.
 */
export function cachedRates(): RateTable | null {
  return read()?.table ?? null;
}

/** The current table, fetching only when what is cached has aged out.
 *
 * Never throws and never rejects: a failure is null, and every caller treats
 * null as "this bidder can use the auction's currency".
 */
export async function rates(): Promise<RateTable | null> {
  const cached = read();
  if (cached && Date.now() - cached.fetchedAt < REFRESH_AFTER_MS) return cached.table;

  // One request even if three parts of the page ask at once.
  inFlight ??= fetchRates().finally(() => {
    inFlight = null;
  });
  const fresh = await inFlight;
  // A stale table beats no table: the rate barely moves in a day and the
  // interface shows its date either way.
  return fresh ?? cached?.table ?? null;
}

async function fetchRates(): Promise<RateTable | null> {
  try {
    const res = await fetch(ENDPOINT, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      result?: string;
      base_code?: string;
      rates?: Record<string, number>;
      time_last_update_utc?: string;
    };
    if (body.result !== 'success' || !body.rates || !body.base_code) return null;
    if (typeof body.rates.USD !== 'number') return null;

    const table: RateTable = {
      base: body.base_code,
      rates: body.rates,
      asOf: new Date(body.time_last_update_utc ?? Date.now()).toISOString(),
    };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ table, fetchedAt: Date.now() }));
    } catch {
      // A full or blocked storage is not a reason to refuse the rate we have.
    }
    return table;
  } catch {
    return null;
  }
}
