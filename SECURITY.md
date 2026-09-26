# Security

bte is an UNAUDITED prototype. The v0 trust model is dealer-trusted.

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

## What holds cryptographically

- Confidentiality below threshold: any coalition of fewer than t operators
  learns nothing about any payload (Shamir + the scheme's batched threshold
  security; see eprint 2026/760).
- Public verifiability: every share is checked against published verification
  keys via `e(pd_j, g_2) == sum_i e(ct_{i,0}, v_j^i)` before it is counted.
  Invalid shares are stored flagged and never used.
- Per-ciphertext integrity: payloads use simple-bte's Fujisaki-Okamoto
  transform. Mauling any part of a ciphertext makes the re-derived
  `[k]_1 == ct0` check fail for that slot only; the batch is not poisoned.

## Known gaps (also in spec/DEVIATIONS.md)

- **CCA via FO, not a submission-time NIZK.** A malformed ciphertext is only
  detected at reveal time, so it can occupy a batch slot until then. The
  scheme's Schnorr-PoK path exists only for group-element messages and is not
  used on the byte-payload path.
- **No replay/binding protection at the API layer.** Anyone can copy a posted
  ciphertext blob into another condition (it will decrypt to the same
  payload). Bind payloads to context yourself (include the condition id or a
  nonce inside the payload) if that matters to your app. The phase 7 anchor
  contract binds ct hashes to conditions onchain.
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
