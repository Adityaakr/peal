# bte spec (v0) — the contract

seal now. reveal on cue. Re-read this file at the start of every phase.

## 1. Overview

bte is a reveal-later encryption network on commonware's batched threshold
encryption (paper: eprint 2026/760, Guru Vamsi Policharla; code:
commonwarexyz/simple-bte). Developers `seal(payload, condition)` to a t-of-n
operator committee; when the condition fires, the batch under that condition
freezes, each operator posts ONE 48-byte share for the whole batch, any t
verified shares recover ALL plaintexts, and everyone can read them. Before the
cue nobody — operators included — can read anything.

Trust model v0: single trusted dealer ceremony
generates tau, Shamir-deals shares of each power tau^i, publishes public params,
destroys tau. No DKG.

## 2. Components

| component | role |
|---|---|
| `crates/bte-crypto` | the only crate touching group elements; wraps simple-bte (see API-MAP.md) |
| `crates/bte-coordinator` | registry + condition engine + aggregator + REST (axum, /v0) + sqlite |
| `crates/bte-node` | operator binary: poll work, compute partial, post share; encrypted keystore |
| `crates/bte-cli` | `ceremony`, `committee init`, dev helpers |
| `packages/sdk` | `bte-sdk` npm package: TS + wasm (seal-only build of bte-crypto) |
| `packages/explorer` | vite + TS explorer: committee, conditions, reveal detail |
| `contracts/` | phase 7: `BteAnchor.sol` commit/revealRoot on Sepolia |

Defaults: committee n=5, t=3, batch B=64 (fixed at ceremony). Coordinator on
:8080, explorer on :5173. Nodes are outbound-only. Payload cap 2 MiB,
enforced at SDK and coordinator. Chainless core: sqlite + content-addressed
ciphertexts; the store is swappable for calldata/blobs later.

## 3. Scheme (fidelity map — deviations only via DEVIATIONS.md)

- Punctured setup: powers of tau in G2 published for j = 0..2B EXCEPT slot B+1
  (zeroed); ek = [tau^(B+1)]_T lives in the target group. Setup only via
  `simple-bte::crs::setup`, which also Shamir-shares tau^1..tau^B (threshold t,
  n parties, 1-based indices) and publishes verification values v_j^i.
- Ciphertext: FO-transformed ElGamal. `ct0 = [k]_1` (48-byte compressed G1 KEM
  header — asserted by test), `ct1 = H_K([k*tau^(B+1)]_T) xor K` (16 bytes),
  `ct2 = H_M(K) xor payload`. CCA via FO re-derivation (DEVIATIONS #2), not a
  separate proof.
- No epochs, no user-chosen slots: sealing takes no batch number and no
  position. Positions are assigned only at freeze, by ascending ct_hash order.
- One share per operator per batch: pd_j = sum_i sigma_j^i * ct_{i,0}; a share
  is one 48-byte compressed G1 element, independent of B.
- Public verifiability: e(pd_j, g_2) == sum_i e(ct_{i,0}, v_j^i), run on every
  submitted share before it is marked valid.
- t-of-n Lagrange combination (`combine`, at x=0) inside `recover`.
- FFT cross-terms: O(B log B) group ops + O(B) pairings via
  `fo::predecrypt_fft`; never the naive B^2 loop.
- Pipelining: cross-terms depend only on ciphertexts + public params ->
  `pre_decrypt` / `finalize` pair; an integration test asserts pre_decrypt
  completes before any share exists.

## 4. Data flows

### Seal
1. SDK fetches + caches PublicParams from coordinator (`GET /v0/committees/:id`).
2. `seal(payload)` (wasm, client-side): FO-encrypt under ek. Nothing secret
   leaves the client unencrypted.
3. `POST /v0/ciphertexts {condition_id, sealed_blob}` -> coordinator validates
   (size caps, parses wire format), stores content-addressed by
   ct_hash = sha256(sealed_blob), status stays `pending`.

### Reveal
1. Condition engine tick: condition fires (wall clock `at_time`, or phase 7
   `at_block` via JSON-RPC poll).
2. Freeze: pad to B with coordinator-self-sealed dummies (is_dummy=true),
   sort ct_hashes ascending -> positions 0..B-1, mark condition `frozen`,
   create batch row, spawn `pre_decrypt` in background (pipelining).
3. Operators poll `GET /v0/work?operator=j`, get frozen batch headers, compute
   partial (one 48-byte G1 MSM), `POST /v0/shares`.
4. Coordinator runs `verify_share` inline; rejected shares stored flagged,
   never used.
5. On t verified shares: Lagrange-combine, `finalize` -> payloads + per-slot
   validity; store payloads + merkle root over (position, payload) leaves;
   mark `revealed`; record predecrypt_ms / finalize_ms.
6. Liveness: frozen without t shares past REVEAL_TIMEOUT_SECS (default 120) ->
   `stalled`, exposed via API/explorer, never a silent hang.

## 5. Wire formats (all tagged BTE_WIRE_V0)

All wire types start with magic `b"BTE0"` (4 bytes) then a type byte. Group
elements are arkworks canonical compressed (G1 48B, G2 96B, G_T 576B, scalar
32B). Multi-byte integers are little-endian.

- `SealedCiphertext` (type 0x01): magic, type, ct0 [48], ct1 [16],
  ct2_len u32, ct2 [ct2_len]. ct_hash = sha256(entire wire bytes).
- `Share` (type 0x02): magic, type, party_index u16, pd_j [48, compressed G1].
- `PublicParams` (type 0x03): magic, type, n u16, t u16, b u32, ek [576],
  powers_of_h count u32 then [96] each (slot B+1 is the identity/zero point),
  verification_keys n*B * [96] (party-major). digest = sha256(entire wire
  bytes). Prepared-pairing forms and FFT tables (fft_size, domain, fft_h) are
  rebuilt deterministically on deserialize.
- `OperatorSecret` (type 0x04): magic, type, party_index u16, B u32,
  shares B * [32]. Never leaves an encrypted keystore or gitignored dev dir.

JSON REST carries wire blobs base64-encoded; hashes/digests hex-encoded.

## 6. REST API (axum, JSON, prefix /v0)

- `POST /conditions` {kind: "at_time"|"at_block", fires_at?|{chain_id,height}} -> {id}
- `POST /ciphertexts` {condition_id, sealed_blob_b64} -> {ct_hash}
- `GET /conditions/:id` -> {status, counts, fires_at, ...}
- `GET /work?operator=j` -> frozen batches lacking a share from j: {batch_id, headers_b64}
- `POST /shares` {batch_id, operator_id, share_b64} -> verify inline; {verified}
- `GET /reveals/:condition_id` -> plaintexts + per-operator share log (submitted_at,
  verified) + predecrypt/finalize ms; 404 while not revealed
- `GET /committees/:id` -> params blob + digest + n/t/B
- `GET /healthz`

Per-IP rate limiting (tower middleware), generous dev defaults. Body limits on.

## 7. Sqlite schema

- `committees(id, params_blob, params_digest, n, t, b, created_at)`
- `conditions(id, committee_id, kind, fires_at, chain_id NULL, height NULL, status, created_at)`
  status: pending | frozen | revealed | stalled
- `ciphertexts(ct_hash PK, condition_id, sealed_blob, is_dummy, position NULL, created_at)`
- `batches(id, condition_id, frozen_at, predecrypt_ms NULL, finalize_ms NULL)`
- `shares(batch_id, operator_id, share_blob, verified, submitted_at, PK(batch_id, operator_id))`
- `reveals(condition_id PK, revealed_at, payloads_blob, merkle_root)`

Merkle root: leaves = sha256(position_le_u32 || payload) in position order,
parent = sha256(left || right), odd node promoted. Root over all B slots
(dummies included, so the root commits to the full batch).

## 8. Invariants (section G — each tested somewhere by the end)

1. Roundtrip exactness. 2. t-1 shares -> explicit error, never garbage.
3. Bad shares flagged, tolerated. 4. No plaintext exists anywhere before reveal
(/v0/reveals on pending -> 404). 5. Padding correctness, dummies marked.
6. Positions are a pure function of the ct_hash set. 7. Mauling rejected
per-ciphertext without poisoning the batch. 8. Golden wire files. 9.
pre_decrypt completes before any share exists. 10. 48-byte KEM header and
48-byte shares on the wire.

## 9. Env vars (all optional, sane defaults)

`BTE_DEV`, `DATABASE_URL` (default `sqlite://bte.db`), `REVEAL_TIMEOUT_SECS`
(120), `BTE_DEVNET_URL` (SDK override), `SEPOLIA_RPC_URL`, `ANCHOR_PRIVATE_KEY`.

## 10. Licensing

Apache-2.0. NOTICE credits commonwarexyz/simple-bte (dual Apache-2.0/MIT) and
eprint 2026/760.
