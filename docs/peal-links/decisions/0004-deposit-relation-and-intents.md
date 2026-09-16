# 0004: Deposits credit a mint receipt proven by R_dep, registered as an intent first

Date: 2026-09-16. Status: accepted.

## Decision
- A deposit of `v` into the gateway is credited by appending a **mint receipt** `rho = Com_rec(v, MINT, A, 1; r'')` to the receipt log, where `MINT` is a fixed identifier (`deposit::mint_sender`). The owner of `A` claims it with the ordinary receive branch of R_op.
- Before appending, the ledger verifies a ZK-Pari proof of **R_dep**: public `(v, rho)`, witness `(A, r'')`, relation `rho = Com_rec(v, MINT, A, 1; r'')` and `v in [0, 2^64)` (`deposit::DepositCircuit`, ~400 R1CS).
- The client proves R_dep and registers the **deposit intent** `(namespace, circuit id, v, rho, proof)` with the ledger *before* signing the on-chain transfer. The on-chain call carries `(token, v, rho)`. The watcher credits when the finalized event matches a registered intent; a deposit whose intent was not registered stays "observed, unregistered" and is credited when the intent arrives.
- The mint is deduplicated by `deposit_id = <chain-id>:<tx-hash>:<log-index>` within the namespace.

## Why
- The ledger cannot see inside `rho`. Without the proof, a depositor could commit to `v' > v` and claim more than they deposited.
- The proof hides `A` from the gateway, the watcher and the ledger operator. What the EVM side learns is `(sender address, v, rho)`; linking `rho` to `A` requires the depositor's witness.
- Intent-first ordering means the irreversible step never happens without the credit path in place, and a lost response never costs a second deposit (`Wallet::pending_deposits` is persisted before the transfer is signed).

## Consequences
- Two verifying keys per instance (`Keys { op, deposit }`), both under one circuit id.
- Threat model: the gateway learns amounts and source wallets; the ledger learns amounts and receipt commitments; neither learns the destination account.
