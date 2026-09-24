# Security

bte is an UNAUDITED prototype. Two schemes run side by side (a committee
names its `scheme`): v0 is dealer-trusted; v1 has a transparent setup from a
DKG. The hosted peal.network coordinator runs a v0 committee until an
operator runs a DKG there.

## Trust model (v0)

- **Trusted dealer.** `bte-cli ceremony` samples tau in-process, Shamir-deals
  shares of tau^1..tau^B (threshold t of n), publishes public parameters, and
  drops tau. A compromised dealer machine at ceremony time compromises every
  payload ever sealed under that committee. There is no DKG, no resharing;
  operator replacement means a new ceremony and new params.
- **Liveness is committee-dependent.** Fewer than t live honest operators
  means no reveal. Stalls are detected and exposed (`stalled` status), not
  worked around.
- **The coordinator is trusted for liveness and ordering, not confidentiality.**
  It sees only ciphertexts before the cue. It assigns positions
  deterministically (sorted ct hashes) and pads batches with self-sealed
  dummies. A malicious coordinator could censor ciphertexts or stall reveals;
  it cannot read anything early.

## Trust model (v1)

Scheme v1 is "DKG Is All You Need" (Policharla, Commonware, 2026); see
`crates/bte-crypto/src/tbte/` and `docs/peal-links/decisions/0015-transparent-bte-from-a-dkg.md`.

- **No dealer.** The committee's whole secret is one scalar `sk`, Shamir-shared
  by Commonware's Feldman/Desmedt DKG (`commonware-cryptography` 2026.9.0,
  `bls12381::dkg::feldman_desmedt`). No machine ever holds `sk`; the public
  parameters are `n + 1` G1 points. Every operator is a dealer and a player,
  identified by an ed25519 key; private dealings travel in X25519 boxes.
- **The coordinator is only a relay** (`/v0/dkg/rounds`,
  `/v0/dkg/rounds/{id}/envelopes`, `/v0/dkg/pending`). It never sees a share,
  cannot forge a dealer (every envelope is signed), and can only stall a
  round, which is visible. Starting a round needs `BTE_ADMIN_TOKEN` (or
  `BTE_DEV=1`).
- **Threshold rule.** Fault model `N3f1`: `f = ⌊(n − 1) / 3⌋`, `t = n − f`.
  Five operators give 4-of-5 (three of four, five of seven). A weaker model
  would give 3-of-5 but loses secrecy under asynchrony, so it is not offered.
  The DKG's bounded reveals assume that synchrony model.
- **Liveness** is as in v0: fewer than t live honest operators means no
  reveal; stalls are exposed, not worked around.

What the relay design enforces after the 2026-09-25 attack review (each
item has a regression test in `crates/bte-coordinator/tests/dkg_relay.rs`
or `tests/tbte_v1.rs`):

- Every operator signs its own X25519 box key; the relay and every node
  refuse a round whose box keys are not vouched for, so the relay cannot
  substitute a key it holds and read private dealings.
- The round digest that every envelope signs covers the relay's round id and
  the box keys, and a node keeps its dealer seed (fresh OS entropy, a 0600
  file) keyed by digest with the round id it dealt under: the same
  configuration served under a second id, or replayed after a relay
  database reset, is refused rather than dealt again with the same
  polynomial.
- Signed dealer logs are checked at the door (signature, round, sender is
  the dealer) and again at settlement, one per dealer; one garbage log
  cannot fail a round, and a round settles only after a margin past its
  deadline.
- Starting a round and registering a committee need `BTE_ADMIN_TOKEN`; the
  `BTE_DEV=1` waiver applies only when the coordinator listens on loopback,
  so a hosted image built with the dev flag still demands the token. v1
  committees are made only by DKG rounds, never posted as parameters.
- Share slots belong to verified shares only: a stranger posting garbage
  under every operator index is recorded in the audit log and cannot lock
  an honest operator out; an operator index outside the committee is
  refused before any pairing; a v1 share costs two pairings to check (the
  batch was admitted at freeze), not a proof per slot.
- Packed batch headers are cached at freeze and served without parsing
  under the database lock; ciphertext proofs are checked outside the lock;
  intake closes before a freeze reads the batch, so nothing accepted during
  the freeze can be left out of it; a second ciphertext with the same KEM
  point is refused with a named reason.

What remains, and is recorded rather than hidden:

- Relay liveness (the coordinator can stall a DKG round or a reveal; a node
  that waits too long for logs the relay listed but never served gives up
  and says so).
- A public v1 condition can be filled by anyone up to its cap (4095
  ciphertexts) with cheap, valid proofs: squatting, not corruption. Sealer
  quotas or paid intake (x402 exists) are the answer, not yet wired.
- Deadlines are compared against the relay's clock as reported with each
  round, which is the honest baseline but still the relay's word.
- The coordinator chooses which quorum of dealer logs settles a round, so it
  can pick among the resulting public keys: Joint-Feldman's known key bias,
  which does not weaken secrecy and is accepted here.
- The `N3f1` synchrony assumption behind the DKG's bounded reveals.
- The sigma-protocol gap: the ciphertext proof is a plain Fiat-Shamir sigma
  protocol. The paper's SE-NIZK definition asks for straight-line
  extractability, which is not separately proven here.
- Unaudited, like v0.
- DoS bound: the default cross-term path is the naive one (`B` MSMs of size
  `B`, see `crates/bte-crypto/src/tbte/poly.rs` for the measurement), so a
  batch is capped at `MAX_BATCH_SLOTS` = 4096 and a condition holds one
  batch (at most 4095 real ciphertexts plus one coordinator decoy).
- No resharing wired yet: operator rotation still means a new DKG round.
  The same Commonware module supports resharing; it is the next roadmap item.

## What holds cryptographically

- Confidentiality below threshold: any coalition of fewer than t operators
  learns nothing about any payload (Shamir + the scheme's batched threshold
  security; v0: eprint 2026/760; v1: "DKG Is All You Need", assumption DBSDH).
- Public verifiability: every share is checked against published verification
  keys before it is counted (v0: `e(pd_j, g_2) == sum_i e(ct_{i,0}, v_j^i)`;
  v1: `e(pd_j, [1]_2) == e(pk_j, sum_i ct2_i)`). Invalid shares are stored
  flagged and never used.
- Per-ciphertext integrity: v0 payloads use simple-bte's Fujisaki-Okamoto
  transform. Mauling any part of a ciphertext makes the re-derived
  `[k]_1 == ct0` check fail for that slot only; the batch is not poisoned.
  v1 ciphertexts carry a sigma-protocol proof of `k` checked at intake and by
  every operator before signing, and a ChaCha20-Poly1305 body whose tag
  fails for that slot only.

## Known gaps (also in spec/DEVIATIONS.md)

- **v0: CCA via FO, not a submission-time NIZK.** A malformed ciphertext is only
  detected at reveal time, so it can occupy a batch slot until then. The
  scheme's Schnorr-PoK path exists only for group-element messages and is not
  used on the byte-payload path. v1 verifies the proof at submission.
- **v0: no replay/binding protection at the API layer.** Anyone can copy a posted
  ciphertext blob into another condition (it will decrypt to the same
  payload). Bind payloads to context yourself (include the condition id or a
  nonce inside the payload) if that matters to your app. The phase 7 anchor
  contract binds ct hashes to conditions onchain. v1 closes this: the proof
  and the AEAD bind a ciphertext to one committee (parameter digest) and one
  context (`peal-condition:<condition id>`), the coordinator requires the
  context to match the condition, and it refuses a second ciphertext with
  the same KEM point under a condition.
- **Rate limiting is per-IP token bucket** with generous dev defaults; the
  public devnet posture is "everything sealed here becomes public, wiped
  weekly".
- **Keystores** are ChaCha20-Poly1305 + argon2id at rest; the passphrase
  arrives via environment variable, which is adequate for a devnet only.
- The wasm SDK trusts the coordinator to serve the right committee params;
  it cross-checks the digest, so pin `params_digest` out of band if you need
  stronger assurance.

## Reporting

Email adityakrx7@gmail.com. This is a testnet toy; expect fast, informal
handling.
