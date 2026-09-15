# Peal Links threat model

First version, Phase A (2026-09-16). Updated as components land. Decisions referenced: `decisions/0002` to `0005`.

## Assets

- Private spend authority (ed25519 spend seed) and the account opening (balance, randomness, claimed-position tree). Loss means loss of funds; disclosure means loss of privacy and, with the seed, of funds.
- Receipt openings `(v, Sen, Rec, r'')`. Disclosure reveals a payment's amount and both parties to whoever holds it.
- Recipient encryption keys (Phase C). Disclosure reveals every receipt delivered to that recipient.
- Gateway reserves (ERC-20 balances held by the contract). Release is authorized only by committee certificates over ledger-finalized withdrawals.

## Observer matrix

Legend: **sees** = learns directly; **link** = can correlate; blank = does not learn from this component.

| Observer | Addresses (EVM) | Amounts | Timing | Request ids | Account associations | Network metadata |
|---|---|---|---|---|---|---|
| Public EVM observer | sees depositor and withdrawal recipient addresses | sees deposit and withdrawal amounts | sees block times | | link deposit `rho` to a later mint only via the ledger's public log (Peal keeps the mapping opaque: `rho` is a commitment) | |
| Bonsai ledger / validators | | operation amounts hidden by R_op; **sees** mint and withdrawal amounts | sees every operation's submission time | | sees acting account per operation (paper's leakage L_ind); sees registration keys; cannot see counterparties, amounts or direction of payments | sees submitter IP and session unless a relay is used |
| RPC / API operator (Peal's node) | | as ledger | as ledger | **sees** request ids on checkout reads and status polls | can link a request id to the payer's account if the same session submits the operation; retained metadata is minimized (Phase E) | sees IP, user agent |
| Request API (product metadata) | | sees requested amounts (public on the checkout page anyway) | sees creation, view and fulfillment times | sees request ids and receiver display names | sees the receiver's account id and encryption key (they are in the signed manifest) | |
| Delivery / archive (inbox) | | | sees when a ciphertext was posted and fetched | | sees the recipient's inbox id per ciphertext (the receiver's encryption public key, not its account id, once Phase C separates them) | sees IPs of poster and fetcher |
| Counterparty (payer) | | sees the amount they paid | sees when | sees the request id | sees the receiver's account id and encryption key | |
| Counterparty (receiver) | | sees the amount received | sees when the opening arrived | sees the request id | sees the sender's account id (inside the opening) | |
| Backup storage | | | | | ciphertext only; the passphrase-derived key never leaves the client | sees upload times if remote (Phase C; local file export first) |
| Settlement signers | | **sees** withdrawal amounts and recipients | sees when | | sees the withdrawing account id | |

## Trust boundaries and what each layer enforces

- **Circuit (R_op, R_dep)**: balance non-negativity and range, receipt inclusion, single claim per position (in the wallet's committed tree), correct commitment transitions, mint receipt amount.
- **Ledger STF** (`peal-bonsai::ledger`): namespace and circuit id match, signature by the account key, strict decoding (canonical field elements, on-curve and in-subgroup points) before pairings, old commitment equals current, revealed root within the window, proof verifies, deposit id unique, atomic write, chained state root, full replay.
- **Wallet**: refuses double claims, overdrafts, receipts not addressed to it, openings that do not match the served leaf and root; journals every transition before submission.
- **Gateway contract (Phase D)**: ERC-20 allowlist, safe transfers, threshold certificate over a domain-bound message, unique withdrawal ids, epoch, pause, reentrancy guard, bounded amounts.
- **Product API (Phase E)**: signed request manifests, EIP-4361-style session auth, idempotency keys bound to contents, rate limits, no secrets in logs.

## Threats considered in Phase A (with the test that exercises them)

| Threat | Enforcement | Test |
|---|---|---|
| Forged or tampered proof | subgroup/canonical decoding, `ZkPari::verify` | `gate_a.rs` (flipped byte, redirected receipt) |
| Replay of an accepted operation | old commitment must equal current | `StaleCommitment` in `gate_a.rs` |
| Two devices racing from one state | order of application; batch re-reads state | `batch_isolates_invalid_proofs_and_resolves_races_deterministically` |
| Cross-namespace replay | namespace in envelope and in `A` | `WrongNamespace` in `gate_a.rs` |
| Unregistered or squatted identifier | signature must match `A`'s key | `UnknownAccount`, `BadSignature` |
| Overdraft | range checks make `b - v` unwitnessable; a lying local balance opens the wrong commitment | `gate_a.rs` greedy wallet |
| Double claim | wallet refuses; in-circuit SMT insertion needs leaf 0 | `gate_a.rs`, upstream `double_receive_unsatisfiable` |
| Claim by the wrong recipient | opening's receiver must equal the proving account, in circuit | `gate_a.rs` thief wallet |
| Duplicate deposit event | `deposits.deposit_id` primary key | `mint` helper in `gate_a.rs` |
| Malformed mint (hidden larger amount) | R_dep proof over the public amount | `Ledger::mint` verifies before appending |
| Store corruption or wrong store | namespace and circuit id bound in `meta`; root of the rebuilt tree must match the recorded one; replay re-verifies every proof | reopen and `verify_replay` in `gate_a.rs` |
| Lost acknowledgement | two-phase journal, `reconcile` from the ledger commitment | `gate_a.rs` crash recovery |

## Not protected (stated plainly)

- Which account acts, and when, is visible to the ledger and anyone reading its log.
- Deposit and withdrawal amounts and EVM addresses are public.
- Submission metadata (IP, timing) can link operations to people.
- The ledger operator can censor or delay; a single-node ledger is a development mode, not a decentralized service.
- The settlement committee can release reserves incorrectly if a threshold of signers is compromised (decision 0005).
- Simulation extractability of ZK-Pari is asserted, not proven (RESEARCH.md); a passing test suite does not change that.
- No formal review of this integration has taken place.
