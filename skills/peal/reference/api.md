# Peal API reference

Base URL `https://peal.network`. Everything is JSON. Nothing needs a key.

Read `GET /v1` at runtime for the limits this deployment enforces rather than
hard-coding them from this file.

## Rounds

### POST /v1/rounds

Name a moment. One of:

- `opens_in` — seconds from now, positive
- `opens_at` — RFC 3339 with an offset (`2026-09-12T18:00:00Z`) or unix seconds
- `opens_at_block` — `{ chain_id, height }`

Plus optional `tag`, `title`, `description`, `image_url` (https only).

Send an `Idempotency-Key` header and a retry returns the same round with 200
instead of creating a second one. Agents retry on timeouts and a duplicate round
is a split auction.

201 and a `Location` on success.

### GET /v1/rounds

Your rounds, newest first. `tag`, `status` (`open` `closing` `opened`
`stalled`), `limit` (1–200, default 25), `cursor`. Returns
`{ data, next_cursor, has_more }`.

### GET /v1/rounds/{id}

200 at every stage, with `status`, `seals`, `slots_including_decoys`,
`opens_at`, `opened_at`. Carries an `ETag`; send `If-None-Match` while waiting
and unchanged polls answer 304.

### POST /v1/rounds/{id}/seals

`{ ciphertext_b64 }`. Parsed, on-curve and subgroup checked before storage. The
seal id is the SHA-256 of the ciphertext, so the same submission twice is the
same seal and needs no idempotency key. 409 once the round has closed.

### GET /v1/rounds/{id}/seals

Ids and positions while open; the same shape with `payload_b64` once opened.

## Seals

### POST /v1/seals

One payload with one deadline, in one call: `{ ciphertext_b64, unlock_at }` or
`unlock_in`, plus optional `tag` and `title`. Returns the seal id and a
`proof_url`.

### GET /v1/seals/{id}

One seal, with its payload once the round has opened.

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

- `GET /v1` — the service description: payload cap, page sizes, rate limits
- `GET /v1/parameters` — public key material with its digest
- `GET /v1/currencies` — 56 currencies with their decimals, searchable with `q`
- `GET /v1/names/{name}` — whether a short link is free. Checking only: claiming
  is a permanent onchain write done from your own key
- `GET /peal.js` — the client, one ES module with the encryption compiled in

## Rate limits

50 requests a second per IP, bursting to 400. Every response carries
`RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`, so a client
never has to be refused to learn its budget.
