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

Scheme v1 (section 3b) runs beside v0 with a transparent setup: the
committee's secret comes from a DKG, no dealer, no batch bound. A committee
names its `scheme`; v0 stays the default for existing committees and for the
hosted coordinator until an operator runs a DKG there.

## 2. Components

| component | role |
|---|---|
| `crates/bte-crypto` | the only crate touching group elements; v0 wraps simple-bte, v1 is `tbte/` (see API-MAP.md) |
| `crates/bte-coordinator` | registry + condition engine + aggregator + REST (axum, /v0) + sqlite; DKG relay for v1 |
| `crates/bte-node` | operator binary: poll work, compute partial, post share; encrypted keystore; v1: `--identity` + `--state-dir`, takes part in DKG rounds |
| `crates/bte-cli` | `ceremony`, `committee init`, dev helpers; v1: `identity-new`, `identity-show`, `dkg-init`, `dkg-status` |
| `packages/sdk` | `bte-sdk` npm package: TS + wasm (seal-only build of bte-crypto) |
| `packages/explorer` | vite + TS explorer: committee, conditions, reveal detail |
| `contracts/` | phase 7: `BteAnchor.sol` commit/revealRoot on Sepolia |

Defaults: v0 committee n=5, t=3, batch B=64 (fixed at ceremony). A v1
committee has no batch bound and its threshold follows the DKG's `N3f1` rule
(t = n − ⌊(n−1)/3⌋): five operators give 4-of-5. Coordinator on :8080,
explorer on :5173. Nodes are outbound-only. Payload cap 5 MiB, enforced at
SDK and coordinator. Chainless core: sqlite + content-addressed ciphertexts;
the store is swappable for calldata/blobs later.

Local stacks: the docker compose files and `docker/start-railway.sh` run the
v0 ceremony stack. `scripts/bte/v1-stack.sh demo` runs the v1 stack without
Docker (coordinator + five node processes, a DKG round through the relay,
seal → reveal).

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

## 3b. Scheme v1 (transparent setup from a DKG)

Paper: "DKG Is All You Need" (Guru-Vamsi Policharla, Commonware, 2026),
Figure 1. Code: `crates/bte-crypto/src/tbte/` (module docs carry the same
map). Decision record: `docs/peal-links/decisions/0015-transparent-bte-from-a-dkg.md`.
Deviations only via DEVIATIONS.md (section "v1").

- Setup: no dealer, no powers of tau. The committee's whole secret is one
  scalar `sk`, Shamir-shared by Commonware's Feldman/Desmedt DKG
  (`commonware-cryptography` 2026.9.0, `bls12381::dkg::feldman_desmedt`,
  Joint-Feldman GJKR99 with signed dealer logs and reveals). Public
  parameters are n + 1 G1 points: `pk = [sk]_1` and `pk_j = [sk_j]_1`.
  `g'` is a hash-to-curve G1 point with unknown discrete log. No batch bound.
- DKG: operators hold ed25519 identities (`bte-cli identity-new`); every
  operator is a dealer and a player; private dealings go in X25519 boxes;
  the coordinator is an untrusted relay (`/v0/dkg/rounds`,
  `/v0/dkg/rounds/{id}/envelopes`, `/v0/dkg/pending`). Fault model `N3f1`:
  t = n − ⌊(n−1)/3⌋ (three of four, four of five, five of seven). Party
  index j (1-based) is the operator's position in the sorted identity set
  plus one, where the DKG evaluates its polynomial. Starting a round:
  `bte-cli dkg-init --coordinator URL --tag TAG --operator identity_hex:box_hex ... --wait-secs N`
  (needs `BTE_ADMIN_TOKEN`, or `BTE_DEV=1` on the coordinator).
- Ciphertext: `ct = ([k]_1, [k]_2, k·(g' + x·pk))` with `x = H([k]_1)`; a
  Fiat-Shamir sigma-protocol proof of `k` (`nizk.rs`) whose challenge covers
  the parameter digest, the context hash, the three points and the body
  hash; a context commitment (Peal's coordinator uses
  `peal-condition:<condition id>`); and a ChaCha20-Poly1305 body keyed from
  the pad `k²·[sk]_T` through HKDF-SHA256. The paper's message is `m = 0`, so
  the pad is the KEM secret and `ct4` is never sent.
- Admission (`check_batch`): every proof verifies, the `x_i` are pairwise
  distinct, Σ ct1_i ≠ 0, at most `MAX_BATCH_SLOTS` = 4096 slots. Operators
  run it before signing; the coordinator runs the proof check at intake.
- One share per operator per batch: `pd_j = sk_j · Σ_i ct1_i`, one G1 point.
- Public verifiability: `e(pd_j, [1]_2) == e(pk_j, Σ_i ct2_i)`.
- t-of-n Lagrange combination at zero (`combine`).
- Per-slot decryption: `S_i = e(pd − W_i, ct2_i) · e(ct3_i, U_i)` with cross
  terms `U_i = Σ_{j≠i} ct2_j/(x_j − x_i)`, `W_i = Σ_{j≠i} ct3_j/(x_j − x_i)`.
  Default is the naive path (B MSMs of size B). The paper's O(B log² B)
  subproduct-tree path (`poly.rs`, `CrossTermStrategy::Fast`) is implemented
  and tested equal, but measured 3.5x–7x slower in arkworks for every batch
  up to 1024 (`crates/bte-crypto/examples/tbte_crossover.rs`), so `Auto`
  takes the naive path below `FAST_PATH_MIN_BATCH`.
- Pipelining as in v0: cross terms depend only on ciphertexts, so
  `pre_decrypt` runs before any share exists; `finalize` opens every slot and
  a failed AEAD tag marks that slot only.
- Coordinator: v1 committees carry `scheme` (`GET /v0/committees/:id` returns
  `scheme` and `setup_digest`; `/v0/work` batches carry `scheme`,
  `committee_id`, `slots`; `/v1/parameters` returns `scheme`). Intake verifies
  the proof against the committee, requires the context to be the condition's,
  refuses a second ciphertext with the same KEM point under a condition, and
  caps the condition at one batch (4095 real ciphertexts plus one coordinator
  decoy). Freeze adds exactly one decoy per v1 condition, which keeps
  Σk ≠ 0 and lets an empty condition reveal.
- SDK/wasm: `Params.info()` includes `scheme`; `Params.seal_for(conditionId,
  payload)` works for both schemes; `Params.seal(payload)` is v0-only;
  `verifyShare` dispatches on the scheme.
- Security assumption DBSDH. The proof is a plain Fiat-Shamir sigma protocol;
  straight-line extractability (the paper's SE-NIZK definition) is not
  separately proven (SECURITY.md).

Wire (`tbte/wire.rs`, magic `b"BTE1"` then a type byte; G1 48 B, G2 96 B,
scalar 32 B, integers little-endian; deserialization is strict: curve and
subgroup checks, canonical scalars, no trailing bytes):

- `Ciphertext` (0x01): overhead beyond the payload is
  `CIPHERTEXT_OVERHEAD_BYTES` = 5 + 48 + 96 + 48 + 32 + 64 + 4 + 16 = 313
  bytes (tag, three points, context hash, proof, body length, AEAD tag).
- `CtHeader` (0x05): `HEADER_BYTES` = 5 + 48 + 96 + 48 + 32 + 32 + 64 = 325
  bytes (tag, three points, context hash, body hash, proof); batches pack
  headers back to back.
- `Share` (0x02): `SHARE_BYTES` = 5 + 2 + 48 = 55 bytes.
- `PublicParams` (0x03): 5 + 4 + 32 + 48·(n+1) bytes (tag, n u16, t u16,
  setup digest, pk, pk_1..pk_n).
- `OperatorSecret` (0x04): tag, party index u16, one 32-byte scalar. Never
  leaves the encrypted state dir.

Tests: `crates/bte-crypto/tests/tbte.rs` (20), `tests/tbte_dkg.rs` (4),
`crates/bte-coordinator/tests/tbte_v1.rs` (6), `tests/dkg_relay.rs` (3).
Local multi-process proof: `scripts/bte/v1-stack.sh demo`.

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
