/** Every endpoint, described once.
 *
 * The page, the curl snippet and the playground are all rendered from this
 * array. Writing the reference by hand and the playground separately guarantees
 * they disagree eventually, and the one nobody notices is stale is the
 * playground, because it only breaks when somebody presses the button.
 *
 * Fields here mirror the request structs in crates/bte-coordinator: CreateRound,
 * ListRounds, CreateSeal, CreateLoneSeal, CreateAuction and CurrencyQuery.
 */

export type Method = 'GET' | 'POST';
export type Where = 'path' | 'query' | 'body' | 'header';

export interface Param {
  name: string;
  in: Where;
  type: string;
  required?: boolean;
  description: string;
  /** Prefilled in the playground, so a caller can press run and see a result
   * rather than first inventing values that pass validation. */
  example?: string;
  /** Rendered as a JSON number rather than a string. */
  numeric?: boolean;
  /** What kind of id this field wants, so a value produced by one endpoint is
   * offered only to fields that can use it. A round id is `cond_…` and a seal
   * id is the sha256 of a ciphertext: filling one with the other produces a
   * confusing 404 on a button somebody just pressed. */
  carry?: 'round' | 'seal';
}

export interface Endpoint {
  id: string;
  group: string;
  method: Method;
  path: string;
  title: string;
  summary: string;
  params: Param[];
  /** What comes back, abbreviated to the fields worth naming. */
  response: string;
  /** Anything a caller gets wrong without being told. */
  note?: string;
  /** True when the playground needs a ciphertext, which cannot be typed: the
   * page offers to encrypt something instead. */
  needsSeal?: boolean;
}

export const GROUPS = ['Rounds', 'Seals', 'Auctions', 'Reference'] as const;

export const ENDPOINTS: Endpoint[] = [
  // ----------------------------------------------------------------- rounds --
  {
    id: 'create-round',
    group: 'Rounds',
    method: 'POST',
    path: '/v1/rounds',
    title: 'Open a round',
    summary:
      'Name a moment. Nothing is encrypted yet: this only says when the round opens, and gives you the id everything else hangs off.',
    params: [
      { name: 'opens_in', in: 'body', type: 'integer', description: 'Seconds from now. Positive.', example: '3600', numeric: true },
      { name: 'opens_at', in: 'body', type: 'string | integer', description: 'Instead of opens_in: RFC 3339 with an offset, or unix seconds. A time with no offset is refused.' },
      { name: 'opens_at_block', in: 'body', type: 'object', description: 'Instead of a clock: { chain_id, height } on a chain the network watches.' },
      { name: 'tag', in: 'body', type: 'string', description: 'Your app label. Up to 32 characters of a-z 0-9 : _ -. How you list your own rounds later.', example: 'my-app' },
      { name: 'title', in: 'body', type: 'string', description: 'Public from creation, unlike anything sealed to the round. Up to 120 characters.', example: 'Signed tour poster' },
      { name: 'description', in: 'body', type: 'string', description: 'Public. Up to 2000 characters.' },
      { name: 'image_url', in: 'body', type: 'string', description: 'Public. https only, up to 500 characters.' },
      { name: 'Idempotency-Key', in: 'header', type: 'string', description: 'Send one and a retry returns the same round with 200 rather than creating a second. Reusing a key with a different body is a mistake, not a retry, and answers 422 idempotency_key_reused.' },
    ],
    response: `{
  "id": "cond_…",
  "status": "open",
  "opens_at": "2026-09-12T18:00:00Z",
  "opens_at_unix": 1789408800,
  "seals": 0,
  "slots_including_decoys": 0,
  "tag": "my-app",
  "title": "Signed tour poster"
}`,
    note: 'Returns 201 with a Location header. Agents retry on timeouts, so send an Idempotency-Key: a duplicate round is a split auction.',
  },
  {
    id: 'list-rounds',
    group: 'Rounds',
    method: 'GET',
    path: '/v1/rounds',
    title: 'List rounds',
    summary: 'Your rounds, newest first. This is the query tags exist for.',
    params: [
      { name: 'tag', in: 'query', type: 'string', description: 'Only rounds with this label.', example: 'my-app' },
      { name: 'status', in: 'query', type: 'string', description: 'One of open, closing, opened, stalled.' },
      { name: 'limit', in: 'query', type: 'integer', description: '1 to 200. Defaults to 25.', example: '5' },
      { name: 'cursor', in: 'query', type: 'string', description: 'From a previous response’s next_cursor.' },
    ],
    response: `{
  "data": [ { "id": "cond_…", "status": "open", … } ],
  "next_cursor": "MTc4…",
  "has_more": true
}`,
    note: 'The cursor orders on (created_at, id). Without the tie-break, rounds created in the same second get skipped or repeated as you page.',
  },
  {
    id: 'get-round',
    group: 'Rounds',
    method: 'GET',
    path: '/v1/rounds/{id}',
    title: 'Read a round',
    summary:
      'One URL, every stage, always 200. There is no 404 standing in for "not open yet".',
    params: [
      { name: 'id', in: 'path', type: 'string', required: true, carry: 'round', description: 'The round id.' },
      { name: 'If-None-Match', in: 'header', type: 'string', description: 'The ETag from a previous read. An unchanged round answers 304 with no body.' },
    ],
    response: `{
  "id": "cond_…",
  "status": "open",          // open | closing | opened | stalled
  "seals": 3,
  "slots_including_decoys": 64,
  "opens_at": "2026-09-12T18:00:00Z",
  "opened_at": null
}`,
    note: 'Carries an ETag over the fields that actually move, so polling a deadline costs a 304 until something happens.',
  },
  // ------------------------------------------------------------------ seals --
  {
    id: 'create-seal',
    group: 'Seals',
    method: 'POST',
    path: '/v1/rounds/{id}/seals',
    title: 'Seal a payload to a round',
    summary:
      'Hand over a ciphertext. The encryption happened on your machine, with batched threshold encryption (BTE) under the committee\'s public parameters; this endpoint has never accepted a plaintext and never will.',
    params: [
      { name: 'id', in: 'path', type: 'string', required: true, carry: 'round', description: 'The round to seal to.' },
      { name: 'ciphertext_b64', in: 'body', type: 'string', required: true, description: 'The sealed payload, base64. Parsed, on curve and subgroup checked before it is stored.' },
    ],
    needsSeal: true,
    response: `{
  "id": "4f858dc3…",         // sha256 of the ciphertext
  "round_id": "cond_…",
  "status": "sealed"
}`,
    note: 'The id is the hash of the ciphertext, so the same submission twice is the same seal and needs no idempotency key. 409 once the round has closed.',
  },
  {
    id: 'list-seals',
    group: 'Seals',
    method: 'GET',
    path: '/v1/rounds/{id}/seals',
    title: 'List a round’s seals',
    summary:
      'Ids and positions while the round is open; the same shape with payload_b64 once it has opened.',
    params: [{ name: 'id', in: 'path', type: 'string', required: true, carry: 'round', description: 'The round id.' }],
    response: `{
  "data": [
    { "id": "4f858dc3…", "position": 3, "status": "opened",
      "payload_b64": "…" }
  ],
  "round": { "id": "cond_…", "status": "opened" }
}`,
    note: 'Nothing can leak early here: before the reveal the coordinator does not hold a payload to leak.',
  },
  {
    id: 'create-lone-seal',
    group: 'Seals',
    method: 'POST',
    path: '/v1/seals',
    title: 'Seal until a time',
    summary:
      'One payload, one deadline, one call. Creates a round holding just this seal and hands back a proof URL.',
    params: [
      { name: 'ciphertext_b64', in: 'body', type: 'string', required: true, description: 'The sealed payload, base64.' },
      { name: 'unlock_in', in: 'body', type: 'integer', description: 'Seconds from now.', example: '3600', numeric: true },
      { name: 'unlock_at', in: 'body', type: 'string | integer', description: 'Instead of unlock_in: RFC 3339 with an offset, or unix seconds.' },
      { name: 'tag', in: 'body', type: 'string', description: 'Your app label.', example: 'my-app' },
      { name: 'title', in: 'body', type: 'string', description: 'Public from creation.' },
    ],
    needsSeal: true,
    response: `{
  "id": "4f858dc3…",
  "round_id": "cond_…",
  "unlock_at": "2026-09-12T18:00:00Z",
  "proof_url": "/v1/seals/4f858dc3…/proof"
}`,
  },
  {
    id: 'get-seal',
    group: 'Seals',
    method: 'GET',
    path: '/v1/seals/{id}',
    title: 'Read a seal',
    summary: 'One seal, with its payload once the round has opened.',
    params: [{ name: 'id', in: 'path', type: 'string', required: true, carry: 'seal', description: 'The seal id, which is the sha256 of its ciphertext.' }],
    response: `{
  "id": "4f858dc3…",
  "round_id": "cond_…",
  "position": 3,
  "status": "sealed",
  "round": { "id": "cond_…", "status": "open" }
}`,
  },
  {
    id: 'get-proof',
    group: 'Seals',
    method: 'GET',
    path: '/v1/seals/{id}/proof',
    title: 'Read a seal’s proof',
    summary:
      'What can actually be checked, and nothing that cannot.',
    params: [{ name: 'id', in: 'path', type: 'string', required: true, carry: 'seal', description: 'The seal id.' }],
    response: `{
  "seal_id": "4f858dc3…",
  "position": 3,
  "ordering_root": "0x…",
  "ordering_committed_at": 1788490917,
  "merkle_root": "0x…",
  "revealed_at": 1788494517,
  "commitment_precedes_reveal": true
}`,
    note: 'The load-bearing field is ordering_committed_at. The batch ordering is written at freeze, before any operator is handed work, so a commitment earlier than the reveal is evidence the set was fixed before anybody could read it. Null rather than false before the round opens.',
  },
  // --------------------------------------------------------------- auctions --
  {
    id: 'create-auction',
    group: 'Auctions',
    method: 'POST',
    path: '/v1/auctions',
    title: 'Open an auction',
    summary:
      'A round with the rules that decide what a bid means. Every bid is sealed with batched threshold encryption and opens only when the round fires. Rules that cannot be satisfied are refused here rather than at the close.',
    params: [
      { name: 'closes_in', in: 'body', type: 'integer', description: 'Seconds from now.', example: '3600', numeric: true },
      { name: 'closes_at', in: 'body', type: 'string | integer', description: 'Instead of closes_in: RFC 3339 with an offset, or unix seconds.' },
      { name: 'currency', in: 'body', type: 'string', description: 'A code from /v1/currencies. Its decimals come with it.', example: 'USD' },
      { name: 'decimals', in: 'body', type: 'integer', description: '0 to 4. Only needed for a code the table does not know.', numeric: true },
      { name: 'reserve_minor', in: 'body', type: 'integer', description: 'Integer MINOR units. Nothing below this can win.', example: '1000', numeric: true },
      { name: 'maximum_minor', in: 'body', type: 'integer', description: 'Integer minor units. Nothing above this can win. Set one: it is what stops a joke bid taking the auction.', example: '50000', numeric: true },
      { name: 'title', in: 'body', type: 'string', description: 'Public from creation.', example: 'Signed tour poster' },
      { name: 'description', in: 'body', type: 'string', description: 'Public. Up to 2000 characters.' },
      { name: 'image_url', in: 'body', type: 'string', description: 'Public. https only.' },
      { name: 'contact_public_key', in: 'body', type: 'string', description: 'The seller’s PUBLIC key, when bidders may attach contact details. Never send the private half.' },
      { name: 'tag', in: 'body', type: 'string', description: 'Your app label.', example: 'my-shop' },
    ],
    response: `{
  "id": "cond_…",
  "status": "open",
  "closes_at": "2026-09-12T18:00:00Z",
  "currency": "USD",
  "decimals": 2,
  "reserve_minor": 1000,
  "maximum_minor": 50000,
  "bid_url": "https://peal.network/#/live/…",
  "check_code": "1C8J T47V",
  "terms_hash": "0x…"
}`,
    note: 'bid_url is a hosted page where somebody can read the terms and bid, so an auction works before you have built an interface. check_code is eight speakable characters a seller reads out and a bidder compares.',
  },
  {
    id: 'get-auction',
    group: 'Auctions',
    method: 'GET',
    path: '/v1/auctions/{id}',
    title: 'Read an auction',
    summary: 'The rules as stored, the bid count, and the links.',
    params: [{ name: 'id', in: 'path', type: 'string', required: true, carry: 'round', description: 'The auction id.' }],
    response: `{
  "id": "cond_…",
  "status": "open",
  "bids": 4,
  "closes_at": "2026-09-12T18:00:00Z",
  "currency": "USD",
  "reserve_minor": 1000,
  "results_url": "/v1/auctions/cond_…/results"
}`,
  },
  {
    id: 'place-bid',
    group: 'Auctions',
    method: 'POST',
    path: '/v1/auctions/{id}/bids',
    title: 'Place a bid',
    summary:
      'A bid is a seal holding the fixed width bid record. Same validation and the same closed check as any other seal.',
    params: [
      { name: 'id', in: 'path', type: 'string', required: true, carry: 'round', description: 'The auction id.' },
      { name: 'ciphertext_b64', in: 'body', type: 'string', required: true, description: 'The encrypted bid record: 320 bytes before encryption, whatever the amount inside it.' },
    ],
    needsSeal: true,
    response: `{
  "id": "4f858dc3…",
  "round_id": "cond_…",
  "status": "sealed"
}`,
    note: 'Every bid is the same size on the wire. Without that the ciphertext length ranks the auction for anyone watching, before a single bid opens.',
  },
  {
    id: 'auction-results',
    group: 'Auctions',
    method: 'GET',
    path: '/v1/auctions/{id}/results',
    title: 'Read the board',
    summary:
      'Every readable bid ranked, the queue the rules allow to win, the winner, and anything discarded with the reason.',
    params: [{ name: 'id', in: 'path', type: 'string', required: true, carry: 'round', description: 'The auction id.' }],
    response: `{
  "status": "opened",
  "bids":   [ { "name": "ana", "amount_minor": 12500,
                "meets_reserve": true, "within_maximum": true } ],
  "queue":  [ … ],           // only those the rules allow to win
  "winner": { "name": "ana", "amount_minor": 12500 },
  "decoys": 60,
  "discarded": []
}`,
    note: 'Before the close, bids is null rather than an empty list, so "not open yet" cannot be read as "nobody bid".',
  },
  // -------------------------------------------------------------- reference --
  {
    id: 'service',
    group: 'Reference',
    method: 'GET',
    path: '/v1',
    title: 'Service description',
    summary:
      'What this deployment accepts. Read it rather than hard-coding limits from prose.',
    params: [],
    response: `{
  "service": "peal",
  "version": "v1",
  "limits": {
    "max_payload_bytes": 5242880,
    "max_page_size": 200,
    "requests_per_second": 50,
    "burst": 400
  }
}`,
  },
  {
    id: 'parameters',
    group: 'Reference',
    method: 'GET',
    path: '/v1/parameters',
    title: 'Public parameters',
    summary:
      'The key material you encrypt against, with the digest a client checks before using it.',
    params: [],
    response: `{
  "id": "ed707ad8…",
  "digest": "ed707ad8…",
  "parameters_b64": "…",
  "operators": 5,
  "threshold": 3,
  "batch_size": 64
}`,
    note: 'The client verifies the digest against the bytes it was served, so a coordinator handing out inconsistent parameters fails loudly rather than producing ciphertexts nobody can open.',
  },
  {
    id: 'currencies',
    group: 'Reference',
    method: 'GET',
    path: '/v1/currencies',
    title: 'Currencies',
    summary:
      'The 56 currencies the API knows, with the decimals each uses. Searchable by code, name or symbol.',
    params: [
      { name: 'q', in: 'query', type: 'string', description: 'Search by code, name or symbol. "rupee", "INR" and "₹" all find the same one.', example: 'rupee' },
      { name: 'limit', in: 'query', type: 'integer', description: '1 to 200. Defaults to 200.', example: '5' },
    ],
    response: `{
  "data": [
    { "code": "INR", "name": "Indian rupee", "decimals": 2, "symbol": "₹" }
  ],
  "total": 56
}`,
    note: 'Pass a known code when you create an auction and the decimals come with it. The yen has none and the Kuwaiti dinar has three.',
  },
  {
    id: 'check-name',
    group: 'Reference',
    method: 'GET',
    path: '/v1/names/{name}',
    title: 'Check a short link',
    summary: 'Whether a name is free, and where it points if it is not.',
    params: [{ name: 'name', in: 'path', type: 'string', required: true, description: '3 to 32 characters of a-z 0-9 and hyphens, not starting or ending with one.', example: 'shoonya' }],
    response: `{
  "name": "shoonya",
  "valid": true,
  "available": false,
  "url": "https://peal.network/shoonya",
  "permanent": true
}`,
    note: 'Checking only. Claiming is a permanent onchain write that can never be undone or repointed, so it happens from your own key rather than from a server acting on your behalf.',
  },
];
