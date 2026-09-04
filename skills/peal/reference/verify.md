# Prove the integration works before saying it does

Do not report success on code that has not run. This script creates a real
auction with a short deadline, bids on it, waits for it to open, and checks the
board. It takes about ninety seconds and exercises every part of the path.

## Run it

```bash
curl -fsSL -o /tmp/peal.js https://peal.network/peal.js
node /tmp/peal-check.mjs
```

`/tmp/peal-check.mjs`:

```js
const { Peal } = await import('/tmp/peal.js');
const peal = new Peal({ url: process.env.PEAL_URL ?? 'https://peal.network' });
const ok = (label, cond) => console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`);

// 1. the service is reachable and says what it accepts
const service = await (await fetch(`${peal.url}/v1`)).json();
ok(`service reachable, payload cap ${service.limits.max_payload_bytes}`, !!service.limits);

// 2. open an auction with rules
const auction = await peal.createAuction({
  title: 'verification run',
  closesIn: 45,
  currency: 'USD',
  reserveMinor: 10_00,
  maximumMinor: 500_00,
  tag: 'verify',
});
ok(`auction created ${auction.id}`, !!auction.id);
ok('decimals came from the currency', auction.decimals === 2);
ok('a page for bidders exists', !!auction.bid_url);
ok('a check code was issued', !!auction.check_code);

// 3. bids, including ones the rules must exclude
for (const b of [
  { name: 'ana', amountMinor: 125_00 },
  { name: 'bo', amountMinor: 90_00 },
  { name: 'too low', amountMinor: 5_00 },
  { name: 'joke', amountMinor: 999_00 },
]) await peal.bid(auction.id, b);

const during = await peal.getAuction(auction.id);
ok(`4 bids in, none readable`, during.bids === 4);
const early = await peal.results(auction.id);
ok('nothing readable before the close', early.bids === null);

// 4. wait for it to open
console.log('waiting for the deadline…');
await peal.waitForOpen(auction.id, { timeoutMs: 180_000, everyMs: 3000 });

// 5. the board
const r = await peal.results(auction.id);
ok('the winner is the highest bid inside the rules', r.winner?.name === 'ana');
ok('the queue excludes the ones the rules bar', r.queue.length === 2);
ok('a bid under the reserve is present but cannot win',
   r.bids.some((b) => b.name === 'too low' && !b.meets_reserve));
ok('a bid over the maximum is present but cannot win',
   r.bids.some((b) => b.name === 'joke' && !b.within_maximum));
ok('nothing was discarded', r.discarded.length === 0);

console.log('\nboard:');
for (const b of r.bids) console.log(`  ${(b.amount_minor / 100).toFixed(2).padStart(8)}  ${b.name}`);
```

## What a pass looks like

```
ok    service reachable, payload cap 5242880
ok    auction created cond_…
ok    decimals came from the currency
ok    a page for bidders exists
ok    a check code was issued
ok    4 bids in, none readable
ok    nothing readable before the close
waiting for the deadline…
ok    the winner is the highest bid inside the rules
ok    the queue excludes the ones the rules bar
ok    a bid under the reserve is present but cannot win
ok    a bid over the maximum is present but cannot win
ok    nothing was discarded
```

## When something fails

- **`ERR_UNSUPPORTED_ESM_URL_SCHEME`** — you imported from a URL in Node. Vendor
  the file: `curl -fsSL -o /tmp/peal.js https://peal.network/peal.js`.
- **`invalid_time`** — the deadline has no offset. See `time.md`.
- **`opens_in_past`** — the deadline has already passed. Check the year.
- **`invalid_decimals` or a wrong-looking amount** — you passed a float. Amounts
  are integer minor units.
- **`round_closed`** — a bid arrived after the deadline. Correct behaviour.
- **the winner is not who you expect** — check the reserve and the maximum, then
  check whether a discarded entry explains it.
- **`bids` is null after the deadline** — the batch has not finished opening.
  Poll `status` until it reads `opened`, which `waitForOpen` does.

## Also check, in the application itself

- The auction id is stored against your own record and survives a restart.
- The bid form seals in the browser, not on the server. There is no code path
  where a plaintext amount reaches a server.
- The deadline you show a user matches the one you sent, formatted in their
  timezone rather than in UTC.
- The results view handles `bids === null` as "still open" rather than as
  "nobody bid".
