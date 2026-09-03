# peal-live

The pure half of Peal Live: a sealed auction a livestream audience can enter
with no wallet, no sign in and no gas.

Nothing here touches the network or the DOM. It is the encoding, the ranking and
the checksum, so all of it is testable without a browser or a coordinator, and
the parts that carry a security claim are pinned by tests rather than by
comment.

## What is in it

| module | what it decides |
|---|---|
| `record.ts` | the exact 288 bytes that get sealed for one bid |
| `terms.ts` | the auction's terms, how they ride in a link, and the checksum a seller reads out |
| `board.ts` | revealed slots in, a ranked queue out |
| `amount.ts` | a typed amount to an integer and back |
| `ciphertext.ts` | a ciphertext's own hash, derived in the browser, and the short receipt from it |
| `contact.ts` | contact details a bidder gives the seller and nobody else |
| `currency.ts` | 56 currencies, with the minor units they actually have |
| `name.ts` | the rules a short link name has to satisfy |

## Four decisions worth knowing

**Every bid record is exactly the same length.** The FO ciphertext body is a
keystream XOR over the plaintext, so a sealed blob is `69 + payload` bytes.
Sealing the digits of a bid directly therefore puts its magnitude on the wire
before anyone is allowed to read it. Measured against the live coordinator:

```
"5"          -> 100 base64 chars
"250"        -> 104
"1000000000" -> 112
```

Padded to a fixed record, all three seal to 228. That property is a test
(`record.test.ts`), not a note.

**The auction id is sealed inside the record.** A ciphertext is not bound to a
condition, so a blob posted to one auction can be replayed into another and will
decrypt cleanly. `buildBoard` reads the auction id out of the sealed bytes and
discards anything naming a different auction.

**A contact is encrypted before it reaches the record.** Everything sealed into
a bid is published when the batch opens: that is what the reveal is. So contact
details sit in the record already encrypted to a key the seller alone holds, and
every other bidder gets bytes that say nothing. The record is a fixed 288 bytes
whether or not one is attached, because a record that grew would announce that
there was one.

**Padding is identified by its marker, not by the flag next to it.** The reveal
API serves an `is_dummy` field, which is the coordinator's assertion.
`BTE_DUMMY_V0:` is in the bytes that were actually sealed, so that is what gets
checked. A test seals a real bid with `is_dummy: true` beside it and expects the
bid to count anyway.

## What it does not do

It does not enforce the close. The coordinator's clock does that, and the
operators sign whatever batch they are handed, so treat the close as asserted
rather than enforced.

It does not make bids binding. Nothing is escrowed anywhere in this package or
the pages that use it.

It does not tell you an auction is the one a seller meant. `checksum` is eight
characters over the terms, built to be read out loud and compared by ear, and
that comparison is the only thing that catches a swapped link. It is a
fingerprint for a human channel, not a commitment.

## Tests

```bash
node_modules/.bin/vitest run --root packages/live
```

217 of them, no network. One more runs the whole thing against the live
coordinator: it seals real bids with real contact details, waits out a real cue,
checks the winner, and then fails to open those details with a stranger's key.
Skipped unless you ask for it, because it takes about eighty seconds:

```bash
PEAL_LIVE_E2E=1 node_modules/.bin/vitest run --root packages/live
```
