# Peal API reference

Base URL `https://peal.network`. Everything is JSON. Nothing needs a key.

Read `GET /v1` at runtime for the limits this deployment enforces rather than
hard-coding them from this file.

## Rounds

### POST /v1/rounds

Name a moment. One of:

- `opens_in`: seconds from now, positive
- `opens_at`: RFC 3339 with an offset (`2026-09-12T18:00:00Z`) or unix seconds
- `opens_at_block`: `{ chain_id, height }`

Plus optional `tag`, `title`, `description`, `image_url` (https only).

Send an `Idempotency-Key` header and a retry returns the same round with 200
instead of creating a second one. Agents retry on timeouts and a duplicate round
is a split auction.

Reusing that key with a **different** body is a mistake rather than a retry, and
answers `422 idempotency_key_reused`. It used to hand back the first round with
a 200, so an agent retrying with a new deadline silently got the old one.

201 and a `Location` on success.

### GET /v1/rounds

Your rounds, newest first. `tag`, `status` (`open` `closing` `opened`
`stalled`), `limit` (1 to 200, default 25), `cursor`. Returns
`{ data, next_cursor, has_more }`.

### GET /v1/rounds/{id}

200 at every stage. `seals` and `slots_including_decoys` are `null` until the
round opens, so a live round does not announce how few sealed to it. Null rather
than zero, so "not yet" is distinguishable from "none".

Returns `status`, `seals`, `slots_including_decoys`,
`opens_at`, `opened_at`. Carries an `ETag`; send `If-None-Match` while waiting
and unchanged polls answer 304.

### POST /v1/rounds/{id}/seals

`{ ciphertext_b64 }`. Parsed, on-curve and subgroup checked before storage. The
seal id is the SHA-256 of the ciphertext, so the same submission twice is the
same seal and needs no idempotency key. 409 once the round has closed.

### GET /v1/rounds/{id}/seals

`data` is `null` until the round opens, with `available_at` alongside it. The
count and the list of ids are the same disclosure: eight ids on an open round is
eight submissions, which is the number a competitor in a sealed auction most
wants. Read your own back with `GET /v1/seals/{id}`; you have the id from your
own POST.

Ids and positions while open; the same shape with `payload_b64` once opened.

## Seals

### POST /v1/seals

One payload with one deadline, in one call: `{ ciphertext_b64, unlock_at }` or
`unlock_in`, plus optional `tag` and `title`. Returns the seal id and a
`proof_url`.

### GET /v1/seals/{id}

One seal, with its payload once the round has opened.

**`payload_b64` is padded, and you have to unwrap it.** `peal.js` pads what it
seals, because a sealed length is public the moment the ciphertext is submitted
and an unpadded bid announces its own size. The padded form is:

```
01                 envelope version
00 00 00 0f        payload length, uint32 big endian
…                  the payload
00 00 00 …         zeros to the next bucket
```

`peal.js` unwraps this for you. Over plain HTTP you must do it yourself, or you
will print five bytes of header and a tail of NULs:

```js
function unwrap(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (bytes.length < 5 || bytes[0] !== 1) return bytes;          // not this envelope
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false);
  if (5 + len > bytes.length) return bytes;
  for (let i = 5 + len; i < bytes.length; i++) if (bytes[i] !== 0) return bytes;
  return bytes.slice(5, 5 + len);
}
```

Anything that is not this envelope comes back untouched: a round can hold
payloads from clients that never used one.

The buckets are 256, 1024, 4096, 16384 and 65536 bytes, and past the largest one
the exact size is sent, because hiding a length there would mean shipping
megabytes to conceal kilobytes. A bucket is a floor rather than a plan: two
payloads that land in different buckets are still told apart. `peal.js` takes
`{ padTo: n }` on `seal`, `encrypt` and `sealUntil` to fix the width yourself,
which is what you want for a format of your own. See "Your own payload, not a
bid" in `reference/recipes.md`.

### GET /v1/seals/{id}/proof

What can be checked: `ordering_root` and `ordering_committed_at`, `merkle_root`,
`revealed_at`, `position`, and `commitment_precedes_reveal`. The ordering root
is written at freeze, before any operator is handed work, so a commitment
earlier than the reveal is evidence the set and its order were fixed before
anybody could open it. Null rather than false before the round opens.

## Auctions

### POST /v1/auctions

Round fields plus `currency`, `decimals`, `reserve_minor`, `maximum_minor`,
`contact_public_key`. Uses `closes_in` / `closes_at` rather than `opens_*`.
Returns `bid_url`, `check_code` and `terms_hash` alongside the rules.

### POST /v1/auctions/{id}/bids

`{ ciphertext_b64 }` holding the fixed-width bid record. Same validation and
closed check as any seal.

### GET /v1/auctions/{id}/results

`bids` ranked, `queue` (those the rules allow to win), `winner`, `decoys`, and
`discarded` with a reason. `bids` is null before the close.

## Everything else

- `GET /v1`: the service description: payload cap, page sizes, rate limits
- `GET /v1/parameters`: public key material with its digest
- `GET /v1/currencies`: 56 currencies with their decimals, searchable with `q`
- `GET /v1/names/{name}`: whether a short link is free. Checking only: claiming
  is a permanent onchain write done from your own key
- `GET /peal.js`: the client, one ES module with the encryption compiled in

## Metered twins

Every route above is also mounted under `/v1/x402`, where it answers 402 until
shown an on chain payment. `POST /v1/rounds` has a twin at
`POST /v1/x402/rounds`, and so on. Same body, same response.

The free routes stay free. See `reference/payments.md`.

- `GET /v0/x402`: what a metered call costs, without triggering a 402

## Rate limits

50 requests a second per IP, bursting to 400. Every response carries
`RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`, so a client
never has to be refused to learn its budget.


## Peal Private Links (`/links/v1`)

A different node, mounted at `https://peal.network/links/v1`. JSON in and out,
errors as `application/problem+json`. Amounts are decimal strings of integer
base units (one exception below); 32-byte ids are 64 lowercase hex characters
without `0x`. Full field lists: `https://peal.network/developers/links-api`.
The public reads can be run from `https://peal.network/developers/api`.

Three kinds of authentication: none; a session (`Authorization: Bearer` from a
wallet sign-in, EIP-4361 message, 12 hours, externally owned accounts only);
an account signature (ed25519 by the private account's spending key, in the
body, or in the `x-peal-inbox-auth` header for inbox reads).

| route | auth | what |
| --- | --- | --- |
| `GET /status` | none | namespaces (id, label, chain, token, decimals, gateway, confirmations, available), `circuit_id`, `signers`, `signer_threshold`, per-ledger `seq` and roots |
| `GET /params`, `GET /params/{name}` | none | the proving key index and the key bytes (`op.pk`, `op.vk`, `deposit.pk`, `deposit.vk`), served by digest with an immutable cache header |
| `GET /ledger/{ns}` | none | `seq`, `receipt_count`, `state_root`, `receipt_root`, `recent_roots`, `minted_total` |
| `GET /ledger/{ns}/accounts/{acct}` | none | the account's current commitment and `updated_seq` |
| `POST /ledger/{ns}/register` | account signature | a new account: `namespace`, `pubkey`, `randomness`, `signature` |
| `POST /ledger/{ns}/ops` | account signature | one operation: `account`, `com`, `com_new`, `receipt`, `root`, a 128-byte `proof`, `pubkey`, `signature`; returns the receipt's `position` |
| `GET /ledger/{ns}/receipts/{pos}/path?size=` | none | a Merkle path for a receipt |
| `GET /ledger/{ns}/history?from=&limit=` | none | the records: `register`, `op`, `mint` |
| `GET /ledger/{ns}/accounting` | none | `minted_total`, `withdrawn_total`, `outstanding_liability` |
| `GET /auth/nonce`, `POST /auth/session`, `GET /auth/me` | none, none, session | sign-in: nonce (10 min), `{message, signature}` to `{token, address, expires_at}`, who am I |
| `POST /requests`, `GET /requests` | session (+ account signature on create) | create a signed manifest; list the caller's requests |
| `GET /requests/{id}?intent=` | none | what a payer reads: `manifest`, `status`, `reserved` |
| `POST /requests/{id}/reserve` | none | `{intent_id}`: a 10-minute soft lock |
| `POST /requests/{id}/fulfill` | account signature | the receiver's acknowledgement |
| `POST /requests/{id}/archive` | session | owner only |
| `PUT /directory`, `GET /directory/{ns}/{address}` | session | publish an EIP-712 `PealLinksAccount` profile; look one up (60 per minute) |
| `POST /inbox/keys`, `GET /inbox/keys/{ns}/{acct}` | account signature, none | bind and read an encryption key |
| `POST /inbox/{ns}/{acct}`, `GET /inbox/{ns}/{acct}?after=` | none, `x-peal-inbox-auth` | deliver an encrypted receipt (8 KiB); read the inbox (200 per page) |
| `POST /deposits/intents`, `GET /deposits/intents/{ns}/{receipt}` | proof, none | register a deposit intent before the chain call; poll it. `amount` here is a JSON number, the one exception |
| `POST /withdrawals`, `GET /withdrawals/{ns}/{position}` | account signature, none | claim a burn and receive the signer certificate; read its status and `tx_hash` |
| `GET /healthz` | none | at the root, not under `/links/v1` |

The SDK (`peal-links`) makes every call above; a client in another language
needs the wasm prover for the writes and can use the reads directly.
