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
