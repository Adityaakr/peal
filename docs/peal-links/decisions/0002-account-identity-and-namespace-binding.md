# 0002: Account identity from an ed25519 spend key, bound to the namespace

Date: 2026-09-16. Status: accepted.

## Decision
- A private account has an **ed25519 spend key** generated from OS or browser randomness (`account::SpendKey`). It is never derived from an EVM signature, address, email, request id or password.
- The account identifier is `A = sha256("peal-links/v1/account-id" || namespace || pk) mod r` (`account::account_id`). The **namespace** (32 bytes, `namespace_id(label)`) names one asset domain: chain, token, gateway, ledger.
- Registration and every operation travel in a signed envelope (`RegisterEnvelope`, `OpEnvelope`) that names the namespace and the circuit id; the ledger refuses anything for another namespace or circuit.
- The value authority is the proof. The signature authorizes registration, attributes submissions, and lets the API rate-limit per account.

## Why
- The circuit's statement names `A`. Deriving `A` from the namespace means a proof made for one ledger has a statement that no other ledger recognizes, so cross-namespace replay is impossible without touching the circuit.
- Registration must be bound to a key, otherwise anyone could register an identifier first and own it.
- ed25519 is small, fast, reviewed (`ed25519-dalek` 2), and works unchanged in wasm; the repo's existing k256 use is for EVM signatures, which stay separate (EVM ownership is not spend authority).

## Consequences
- The same spend key yields different `A` per namespace. A wallet holds one state per namespace.
- Envelopes also carry the claimed old commitment so a stale operation is rejected before any pairing (`ledger::Ledger::apply`).
