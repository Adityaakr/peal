# Peal Links architecture

Updated through Phase D (2026-09-16).

## Components

| Component | Location | Language | Status |
|---|---|---|---|
| Bonsai core: parameters, encodings, trees, accounts, wallet journal, ledger STF, deposit relation, withdrawal disclosure, envelopes, manifests | `crates/peal-bonsai` | Rust | built |
| Pinned upstream circuits and SNARK | `zkpari` git dep, rev `a8266aac` (PR #2) | Rust | pinned |
| Node: ledger API with per-namespace actors, params by digest, EIP-4361 sessions, requests, inbox, deposit intents, watcher, settlement committee, withdrawals, accounting | `crates/peal-links-node` | Rust (axum, rusqlite, reqwest) | built |
| Wallet wasm: proving, receipt envelopes, backups, storage sealing | `crates/peal-links-wasm` | Rust, wasm-bindgen (single-threaded) | built |
| SDK: node client, worker prover, account flows, IndexedDB storage, chain helpers | `packages/links` | TypeScript (viem for chain calls) | built |
| Gateway and test token | `contracts/src/links/` | Solidity 0.8.28, OpenZeppelin 5.1 | built, 10 Foundry tests |
| Frontend: landing, app, checkout | `packages/explorer/src/pages/bonsai-*.ts`, `pay.ts`, `src/links/` | TypeScript (vanilla explorer) | built |
| Local stack | `scripts/peal-links/stack.sh` | shell | built (no Docker on the build machine) |
| Consensus (multi-node ordering) | Commonware `simplex` 2026.9.0 | Rust | **not started** (blocker in BUILD_STATUS.md) |

## Data flow (as built)

```
payer browser (worker: wasm)             Peal Links node (:8790)                 receiver browser
--------------------------------------   ----------------------------------------  --------------------------------
GET /requests/<id>  ------------------>  product sqlite                      <----  POST /requests (signed manifest, session)
verify manifest signature in wasm
create/unlock account (IndexedDB)
prepare deposit: R_dep proof  -------->  POST /deposits/intents (verified, stored)
wallet: approve + gateway.deposit  --->  anvil chain A: Deposit(id, token, from, amount, rho)
                                         watcher: confirmations, dedup, credit_intent -> ledger.mint
sync: intent minted -> add receipt
GET receipts/<pos>/path; verify
prove R_op receive (claim)  ---------->  POST /ledger/<ns>/ops -> actor batch verify -> sqlite
POST /requests/<id>/reserve
prove R_op send to receiver  --------->  POST /ledger/<ns>/ops
seal opening to enc key  ------------->  POST /inbox/<ns>/<acct>              ---->  GET /inbox (account-signed), open, add receipt
                                                                                    GET path; verify; prove R_op receive; POST ops
                                                                                    POST /requests/<id>/fulfill (signed ack)
                                                                                    prove R_op send to WITHDRAW; POST ops
                                         POST /withdrawals (claim): signer policy,   <----  withdrawal_claim (signed disclosure)
                                         consume, EIP-712 digest, committee sigs
                                         anvil: gateway.withdraw(msg, sigs)          <----  wallet submits the certificate
                                         watcher: Withdrawn -> status confirmed
```

## Ledger state and invariants

- Per namespace (`ledger-<ns>.sqlite`): `accounts(A -> com)`, `receipts(position -> leaf)`, `roots(size -> root)`, `deposits(deposit_id)`, `ops(seq -> envelope, state_root)`.
- State root: a `sha256` chain over every accepted register, mint and op, including the receipt root after each append. Replayable from `ops` with every proof re-verified (`Ledger::verify_replay`).
- STF invariants: one commitment per account; an op's claimed old commitment equals the stored one; the revealed root is within the last W roots; every proof verified under the pinned verifying key; deposit ids unique; every accepted op appends exactly one receipt.
- Actor: one thread per namespace owns the ledger; `Apply` commands arriving within `batch_window_ms` (25 ms) or up to `batch_max` (64) are batch-verified, with per-proof isolation on failure; reads are served by the same thread from the in-memory tree.
- Conservation (bookkeeping): `GET /ledger/<ns>/accounting` reports `minted_total - withdrawn_total = outstanding_liability`, which the bridge test checks against the sum of wallet balances and the gateway reserve. User balances are proof-enforced; this aggregate is for operators.

## Wallet state and journal

- `Wallet` JSON (sealed at rest under a random storage key, itself wrapped by argon2id from the passphrase): spend seed, x25519 seed, namespace, account id, balance, opening randomness, `ClaimedSet`, held receipts with status, pending deposits, sent openings (for withdrawals and re-delivery), pending op, history.
- Two-phase journal: `prepare_* -> prove_pending -> (ledger) -> commit_pending | abort_pending`; `reconcile(ledger_com)` resolves an unknown outcome after a crash. The SDK saves the sealed wallet before every submission and keeps an outbox for undelivered receipt envelopes.

## Circuits and keys

- R_op (upstream `OpCircuit`, Poseidon, depth 32/32): 51,791 SR1CS constraints, domain 2^16, proof 128 bytes.
- R_dep (`peal_bonsai::deposit::DepositCircuit`): one Poseidon hash plus a 64-bit range check.
- Keys: `Keys::load_or_generate(params_dir)`; circuit id = version, backend, depths, both matrix digests. Served by digest at `/links/v1/params/<file>`; the proving key is uncompressed (30 MB) so the browser skips 300k square roots; clients validate the verifying keys' points and trust the proving key by digest.

## Trust model of the local demo

- Proofs: real, pinned ZK-Pari, verified by the ledger STF.
- Ledger: single node (development mode; consensus not started).
- Setup: locally generated keys; no ceremony.
- Bridge: committee-attested gateway; locally a single-process signer fixture with three of anvil's public keys (threshold 2), labelled in `GET /links/v1/status` as `signer_mode: single-process-fixture`.
- Funds: `TestUSD` (6 decimals) minted from a faucet on two anvil chains; nothing has value.
