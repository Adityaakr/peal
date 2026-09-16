# 0005: Withdrawals are sends to a burn identifier, released by a committee-attested gateway

Date: 2026-09-16. Status: accepted (design; implemented in Phase D).

## Decision
- A withdrawal is an ordinary R_op **send** whose hidden receiver is the namespace's fixed **WITHDRAW** identifier (no key derives it, so the receipt is unclaimable). After the ledger finalizes the send, the withdrawer discloses the receipt opening `(v, A, WITHDRAW, r'')` plus the destination EVM address to the ledger's settlement path. The ledger checks the opening against the appended leaf, records the receipt as consumed (exactly once), and emits a canonical withdrawal message `(namespace, chain id, gateway address, token, recipient, amount, withdrawal id = receipt position, epoch)`.
- **Settlement trust model: committee-attested.** Independently keyed signers each verify the ledger's finalized record and sign the withdrawal message. The gateway contract verifies a threshold of signatures from the current epoch's signer set, checks chain id, contract address, token, amount bounds and the unique withdrawal id, stores the id, and transfers tokens. Signer rotation is by epoch; the contract can be paused.
- This is **not** trustless, ZK-settled or rollup-secured. A compromised signer threshold can authorize invalid releases. The local fixture runs all signers in one process and says so wherever it appears.

## Why
- Reusing R_op means no new consensus-side relation: the debit invariant (balance decreases by `v`, proven) comes from the same circuit, and the burn is real: nobody holds an opening for WITHDRAW's account, and the ledger marks the receipt consumed so the opening cannot be presented twice.
- A proof-verified settlement adapter needs an aggregate or state-transition proof plus data availability on the EVM side; that is a separate design (documented in MAINNET_READINESS.md) and is not substituted with a mock verifier.

## Consequences
- Withdrawals reveal amount and acting account to the ledger and signers, and amount and recipient publicly on the EVM. Documented in THREAT_MODEL.md.
- If the operator disappears, funds that have not been withdrawn are stuck: a user needs a live ledger and a signer threshold to exit. Stated plainly in the product copy and MAINNET_READINESS.md.
