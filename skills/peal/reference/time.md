# Turning a spoken deadline into an exact instant

A user says "Monday at 6pm". The API needs a moment. An auction that closes at
the wrong hour cannot be undone, so resolve this carefully and confirm it.

## The rule

1. Work out the user's timezone. Ask if it is not obvious; do not assume the
   server's.
2. Resolve the phrase to a concrete date.
3. **Confirm it back in full** before creating anything: "closing Monday 8
   September at 18:00 in Europe/London, which is 17:00 UTC". A confirmed wrong
   date is fixable; a created one is not.
4. Pass a `Date` or an ISO string with an offset.

## What the API accepts

```js
closesIn: 3600                              // seconds from now
closesAt: '2026-09-12T18:00:00Z'            // RFC 3339, UTC
closesAt: '2026-09-12T18:00:00+05:45'       // RFC 3339, a specific offset
closesAt: 1789408800                        // unix seconds
closesAt: new Date(...)                     // serialised as UTC for you
```

**Refused:** `'2026-09-12T18:00'`. No offset means a different instant in every
timezone, so it comes back as `invalid_time` rather than a guess. The deadline
must also be in the future, or `opens_in_past`.

Responses always come back in UTC as `closes_at`, with `closes_at_unix` beside
it. Format it in the reader's timezone when you display it.

## Worked examples

Assume today is Thursday 4 September 2026 and the user is in Europe/London.

### "Monday at 6pm"

The next Monday is 8 September.

```js
// Node 22 and every modern browser: resolve in a named zone without a library.
function atLocalTime(dateISO, hour, minute, timeZone) {
  // Start from the wall-clock instant as if it were UTC, then correct by the
  // zone's offset at that moment. Two steps, because the offset depends on the
  // date: London is +01:00 in September and +00:00 in December.
  const naive = new Date(`${dateISO}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const local = new Date(naive.toLocaleString('en-US', { timeZone }));
  const utc = new Date(naive.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(naive.getTime() + (utc.getTime() - local.getTime()));
}

const closesAt = atLocalTime('2026-09-08', 18, 0, 'Europe/London');
// 2026-09-08T17:00:00.000Z — 18:00 London, which is BST in September
```

Confirm: "closing Monday 8 September at 18:00 London time (17:00 UTC)".

### "in two hours"

```js
closesIn: 2 * 60 * 60
```

Relative is exact and needs no timezone. Prefer it whenever the user speaks in
durations.

### "end of the day Friday"

Ambiguous. Ask. "End of day" is 17:00 to some people and 23:59 to others, and
the difference decides who wins.

### From a form input

```html
<input type="datetime-local" name="closesAt">
```

```js
// A datetime-local value is wall-clock in the browser's own timezone, and
// `new Date(value)` interprets it that way, which is what you want.
const closesAt = new Date(form.closesAt.value);
```

### From a database

If you store timestamps as UTC, pass them straight through:

```js
closesAt: listing.auctionEndsAt.toISOString()
```

## The traps

- **`setHours` uses the runtime's timezone.** On a server that is usually UTC,
  so `d.setHours(18)` is 18:00 UTC, not the seller's evening. Use a named zone.
- **Daylight saving moves the offset.** London is +01:00 in September and
  +00:00 in December, so a fixed offset hard-coded once is wrong half the year.
  Resolve against the zone, not against a number.
- **"Next Friday" is ambiguous** when today is a Friday. Ask.
- **Do not silently round.** If the user says 6pm, close at 18:00:00, not at
  the top of the next hour.

## Sanity check before creating

```js
const seconds = Math.round((closesAt.getTime() - Date.now()) / 1000);
if (seconds <= 0) throw new Error('that deadline has already passed');
if (seconds > 90 * 86400) throw new Error('more than 90 days away — confirm the year');
```

A year typed wrong is the most common way a deadline ends up absurd, and it is
cheap to catch before the auction exists.
