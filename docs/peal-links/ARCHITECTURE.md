# Peal Links architecture

First version, Phase A (2026-09-16). Components marked *planned* land in later phases; this file is updated as they do.

## Components

| Component | Location | Language | Status |
|---|---|---|---|
| Bonsai core: parameters, encodings, trees, accounts, wallet, ledger STF | `crates/peal-bonsai` | Rust | built (Phase A) |
| Pinned upstream circuits and SNARK | `zkpari` git dep, rev `a8266aac` | Rust | pinned |
| Ledger node: HTTP API, product API, inbox, watcher, settlement signer | `crates/peal-links-node` | Rust (axum, rusqlite) | *planned, Phase C/D* |
| Consensus (multi-node ordering) | `crates/peal-links-node`, Commonware `simplex` 2026.9.0 | Rust | *planned, Phase C* |
| Wallet wasm (proving, receipt encryption, backup encryption) | `crates/peal-links-wasm` | Rust, wasm-bindgen | *planned, Phase C* |
| Typed SDK | `packages/links` | TypeScript | *planned, Phase C* |
| Gateway contracts | `contracts/src/links/` | Solidity (Foundry) | *planned, Phase D* |
| Frontend: landing, checkout, dashboard | `packages/explorer/src/pages/bonsai*.ts`, `pay.ts` | TypeScript (vanilla, existing explorer) | *planned, Phase B/E* |
| Local stack | `scripts/peal-links/` | shell | *planned* |

## Data flow (target)

```
payer browser                      Peal Links node                    receiver browser
------------------------------     ---------------------------        ------------------------------
open /pay/<id> ---------------->   GET request manifest  <--------    create request (signed manifest)
verify manifest signature          (product sqlite)
connect EVM wallet
[prepare deposit: R_dep proof] ->  register deposit intent
ERC-20 approve + gateway.deposit   watcher: eth_getLogs, finality
                                   ledger.mint(intent, deposit_id)
fetch path for mint receipt   <-   GET receipt path/root
prove R_op receive (claim)    ->   ledger.apply
prove R_op send to receiver   ->   ledger.apply  (receipt appended)
encrypt opening to receiver   ->   POST inbox (ciphertext)   ------>  fetch inbox, decrypt opening
                                   GET receipt path/root     ------>  verify leaf under root
                                   ledger.apply              <------  prove R_op receive (claim)
                                                                       (later) prove R_op send to WITHDRAW,
                                   consume opening, sign certificate   disclose opening + EVM recipient
                                   signers -> gateway.withdraw(cert)   tokens released on the backing chain
```

## Ledger state and invariants

- Per namespace: `accounts(A -> com)`, `receipts(position -> leaf)`, `roots(size -> root)`, `deposits(deposit_id)`, `ops(seq -> envelope, state_root)`.
- State root: `sha256` chain over every accepted register, mint and op, including the receipt root after each append. Replayable from `ops` with every proof re-verified (`Ledger::verify_replay`).
- Invariants enforced by the STF: one commitment per account; an op's claimed old commitment equals the stored one; revealed root within the last W roots; every proof verified under the pinned verifying key; deposit ids unique; every accepted op appends exactly one receipt.
- Conservation (bookkeeping, Phase D): `minted_total - withdrawn_total = sum of balances + unclaimed real receipts`. User balances are proof-enforced; the aggregate is reconciled against gateway reserves per backing domain.

## Wallet state and journal

- `Wallet` (JSON, encrypted by the SDK): spend seed, namespace, account id, balance, opening randomness, `ClaimedSet`, held receipts with status, pending deposits, pending op, history.
- Two-phase journal: `prepare_* -> prove_pending -> (ledger) -> commit_pending | abort_pending`; `reconcile(ledger_com)` resolves an unknown outcome after a crash.

## Circuits and keys

- R_op (upstream `OpCircuit`, Poseidon, depth 32/32): 51,791 SR1CS constraints, domain 2^16, proof 128 bytes.
- R_dep (`peal_bonsai::deposit::DepositCircuit`): one Poseidon hash plus a 64-bit range check.
- Keys: `Keys::load_or_generate(params_dir)`; circuit id = version, backend, depths, both matrix digests. Keys are served to clients by digest (Phase C).

## Trust model of the local demo (to be kept current)

- Proofs: real, pinned ZK-Pari, verified by the ledger STF.
- Ledger: single node in Phase A/B (development mode), multi-node Commonware simplex planned for Phase C.
- Setup: locally generated keys; no ceremony.
- Bridge (Phase D): committee-attested gateway with a labeled single-process signer fixture locally.
