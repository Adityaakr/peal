# Peal Links threat model

Updated through Phase D (2026-09-16). Decisions referenced: `decisions/0002` to `0005`.

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
| Settlement signers | | **sees** withdrawal amounts and recipients | sees when | | sees the withdrawing account id and the burn's receipt opening | |
| Gateway contract and its chain | sees depositor and withdrawal recipient addresses | sees deposit and withdrawal amounts | sees block times | | sees the receipt commitment `rho` of a deposit (a hiding commitment; the account inside it is not derivable) and the `withdrawalId` (hash of namespace and burn position) | |
| Watcher (in the node) | sees depositor addresses | sees deposit amounts | sees block numbers | | links a deposit event to a registered intent's receipt, so it learns which receipt a deposit funds; it does not learn the account, which only the R_dep witness holds | |

## Trust boundaries and what each layer enforces

- **Circuit (R_op, R_dep)**: balance non-negativity and range, receipt inclusion, single claim per position (in the wallet's committed tree), correct commitment transitions, mint receipt amount.
- **Ledger STF** (`peal-bonsai::ledger`): namespace and circuit id match, signature by the account key, strict decoding (canonical field elements, on-curve and in-subgroup points) before pairings, old commitment equals current, revealed root within the window, proof verifies, deposit id unique, atomic write, chained state root, full replay.
- **Wallet**: refuses double claims, overdrafts, receipts not addressed to it, openings that do not match the served leaf and root; journals every transition before submission.
- **Gateway contract** (`contracts/src/links/PealLinksGateway.sol`): ERC-20 allowlist, exact-amount transfers (fee-on-transfer refused), threshold ECDSA certificate over an EIP-712 message bound to chain id, gateway address and signer epoch, unique withdrawal ids, per-token caps, pause, reentrancy guard, owner-only rotation, no sweep.
- **Watcher** (`crates/peal-links-node/src/watcher.rs`): verifies chain id and contract code before marking a namespace available; credits only events from the configured gateway and token, at least `confirmations` blocks deep, deduplicated by `chain:tx:logIndex`; detects a changed block hash under its cursor and rewinds; a deposit whose amount differs from its registered intent is never credited (recorded as `wrong_amount`).
- **Settlement** (`settlement.rs`): every signer checks the burn opening against the ledger leaf, the claim signature, and the account before signing; positions are consumed exactly once by a primary key; the message names the gateway's current epoch.
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

## Threats added in Phase D (with the test that exercises them)

| Threat | Enforcement | Test |
|---|---|---|
| Deposit credited for more than arrived (fee-on-transfer, rebasing) | balance-difference check in `deposit` | `test_deposit_rejects_unallowed_token_zero_amount_and_fee_on_transfer` |
| Depositor commits to a larger amount than deposited | R_dep proof over the public amount; watcher compares the chain amount with the intent and refuses on mismatch | `register_intent` verifies; `watcher::credit` |
| Duplicate credit (same log twice, restart, rewind) | `deposit_id` primary key in the ledger's `deposits` table | `gate_a.rs` mint helper; `bridge.test.ts` second deposit for a minted receipt |
| Withdrawal without a burn | signers verify the opening against the ledger leaf at the position | `settlement::SignerPolicy::check` |
| Withdrawal replayed | `consumed[withdrawalId]` on chain; `(namespace, position)` primary key on the node | `test_withdraw_with_threshold_releases_once`; `bridge.test.ts` replay |
| Certificate replayed on another chain or gateway | chain id and gateway address inside the signed message | `test_withdraw_rejects_wrong_domain_recipient_amount_and_cap`; `bridge.test.ts` chain B replay |
| Stale committee | epoch in the message, only the current epoch accepted | `test_withdraw_rejects_stale_epoch_after_rotation` |
| Duplicate or unsorted signers counted twice | strictly ascending signer addresses | `test_withdraw_needs_threshold_and_distinct_sorted_signers` |
| Reentrancy through a malicious token | `nonReentrant` on deposit and withdraw | `test_withdraw_refused_when_paused_and_reentrancy_blocked` |
| Owner drains reserves | no sweep function exists; the owner rotates signers, which is the documented committee trust | `test_owner_cannot_move_funds_directly_and_only_owner_administers` |
| Cross-domain reserve consumption | one ledger, one gateway, one token per namespace; a certificate for chain A fails on chain B | `bridge.test.ts` |

## Not protected (stated plainly)

- Which account acts, and when, is visible to the ledger and anyone reading its log.
- Deposit and withdrawal amounts and EVM addresses are public.
- Submission metadata (IP, timing) can link operations to people.
- The ledger operator can censor or delay; a single-node ledger is a development mode, not a decentralized service.
- The settlement committee can release reserves incorrectly if a threshold of signers is compromised (decision 0005). Locally the committee is a single-process fixture inside the node, which is no separation at all.
- The gateway owner can rotate the signer set, so the owner key is equivalent to the committee after one rotation; production needs a timelock and multisig on it.
- Deposits credited under the confirmation policy and later reorged away are the accepted risk of that policy.
- Simulation extractability of ZK-Pari is asserted, not proven (RESEARCH.md); a passing test suite does not change that.
- No formal review of this integration has taken place.
