# Error codes and limits

## Codes

Branch on `code`. `detail` is for people and its wording is not part of the
contract. `field` names the input at fault when one input is.

| code | meaning |
| --- | --- |
| `malformed_json` | the body is not valid JSON (400) |
| `invalid_body` | valid JSON, wrong shape: a string where a number belongs (422) |
| `unsupported_media_type` | no `Content-Type: application/json` (415) |
| `payload_too_large` | the body is bigger than the endpoint accepts (413) |
| `idempotency_key_reused` | that key was used with a different request (422). Use a new key, or resend the original |
| `missing_deadline` | no `opens_in`, `opens_at` or `opens_at_block` |
| `opens_in_past` | the deadline has already passed; nothing could be sealed to it |
| `invalid_time` | not RFC 3339 with an offset, and not unix seconds |
| `invalid_tag` | over 32 characters, or outside `a-z 0-9 : _ -` |
| `invalid_title` | over 120 characters |
| `invalid_description` | over 2000 characters |
| `invalid_image_url` | not `https://`, over 500 characters, or contains whitespace |
| `invalid_currency` | empty, or over 12 characters |
| `invalid_decimals` | outside 0 to 4 |
| `invalid_reserve` | negative, or over the amount ceiling |
| `invalid_maximum` | over the ceiling, or below the reserve |
| `invalid_base64` | `ciphertext_b64` is not valid base64 |
| `invalid_ciphertext` | well-formed base64, but not a real ciphertext (422) |
| `payload_too_large` | over the payload cap |
| `round_closed` | the round or auction has already closed (409) |
| `invalid_cursor` | not a cursor the API issued |
| `invalid_status` | not one of `open` `closing` `opened` `stalled` |
| `not_found` | no such round, seal or auction |
| `registry_unreachable` | the name registry could not be reached (503) |

## Limits

Creating a round or auction:

- `title` 120 characters
- `description` 2000 characters
- `image_url` 500 characters, https only, no whitespace
- `tag` 32 characters of `a-z 0-9 : _ -`
- `currency` 1 to 12 characters; a known code fills in `decimals`
- `decimals` 0 to 4
- `reserve_minor`, `maximum_minor` 0 to 1,000,000,000,000 minor units, and the
  maximum may not be below the reserve
- `Idempotency-Key` 200 characters, remembered for 24 hours

Bidding and sealing:

- `amountMinor` 1 to 1,000,000,000,000, a whole number
- bidder `name` 48 **bytes** of UTF-8. An emoji is four, so twelve is the limit
- sealed contact 157 bytes; up to 63 bytes of text inside it
- every bid is 320 bytes before encryption, whatever it contains
- a raw seal is padded to 256, 1024, 4096, 16384 or 65536 bytes, capped at 5 MB

Reading:

- `limit` 1 to 200, default 25
- 50 requests a second per IP, bursting to 400
- batches are 64 slots; a smaller round is padded with decoys, so the slot count
  is never the number of participants


## Peal Private Links (`/links/v1`)

A different node with its own codes. Same `application/problem+json` shape
with `type`, `title`, `status`, `code`, `detail`. Match on `code`.

| code | status | what happened |
| --- | --- | --- |
| `malformed` | 400 | a hex field is the wrong length, a field element is not canonical, a proof is not 128 bytes |
| `wrong_namespace`, `wrong_circuit`, `wrong_chain` | 400 | the body names a different namespace, circuit id or chain than the path or the node |
| `unknown_namespace` | 400 in a body, 404 on a path | no such namespace on this node |
| `bad_siwe`, `bad_manifest`, `bad_profile`, `bad_opening` | 400 | the sign-in message, request manifest, directory profile or withdrawal opening did not validate; a bad manifest signature is `bad_manifest`, not 401 |
| `unregistered_receiver`, `unregistered_account` | 400 | the account in the manifest or profile is not on the ledger yet |
| `too_large` | 400 | an inbox envelope over 8 KiB |
| `unauthorized` | 401 | no session, an expired one, a bad account signature, or an inbox read header older than two minutes |
| `unknown_account`, `unknown_request`, `unknown_intent`, `unknown_withdrawal`, `unknown_param`, `not_registered`, `no_key`, `no_backup` | 404 | the thing does not exist |
| `single_node` | 404 | `/consensus` on a node with no validators |
| `account_exists` | 409 | registering an account a second time |
| `stale_commitment` | 409 | the proof was made against a commitment the ledger has since moved; refresh the wallet and prove again |
| `root_not_recent` | 409 | the receipt path is older than the last 1024 roots; fetch a fresh path |
| `request_exists` | 409 | a different manifest under an id already used |
| `reserved`, `not_payable` | 409 | another payer holds the request; or it is expired, fulfilled or archived |
| `stale_binding`, `profile_rejected`, `backup_rejected` | 409 | the sequence or version did not increase |
| `already_attested`, `already_consumed`, `already_minted`, `duplicate_deposit` | 409 | a second, different claim for the same burn; a withdrawal id already used on the chain; a deposit credited twice |
| `invalid_proof` | 422 | the zero-knowledge proof did not verify: wrong keys for this circuit, or a tampered envelope |
| `rate_limited` | 429 | more than 60 directory lookups in a minute on one session |
| `log_full` | 503 | the receipt log is at capacity |
| `no_gateway`, `no_committee`, `no_consensus`, `not_enough_signers`, `chain_unreachable` | 503 | settlement cannot certify a withdrawal right now; retry |

Through the SDK, every 502, 503 and 504 and every non-JSON answer arrives as
`LinksApiError` with status 0 and code `unreachable`; the 503 codes above are
therefore only visible over raw HTTP. 4xx and 500 keep their status and code.

### Limits

| what | limit |
| --- | --- |
| any request body | 256 KiB |
| an inbox envelope | 8 KiB |
| a backup blob | 1 MiB; the last 8 versions are kept |
| a sign-in message | 4096 characters; nonce valid 10 minutes; session 12 hours |
| a request | title 1 to 140 characters, display name 1 to 60, reference up to 64; `created_at` within the last hour |
| a request reservation | 10 minutes, renewable by the same intent id |
| a payment intent | 10 minutes |
| directory lookups | 60 per session per minute |
| inbox page, request list | 200 items, 500 requests |
| proof freshness | the root must be among the last 1024 |
| deposit credit | after the namespace's confirmations, 2 on Sepolia |
