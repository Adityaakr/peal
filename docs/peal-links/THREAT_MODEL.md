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
| Directory (in the node; decisions 0011, 0013) | **sees** every registered user's 0x address | | sees profile publication times; lookups are rate-counted, not logged | | **sees the 0x-to-Bonsai association**: each signed receiving profile names the wallet address, the Bonsai account id, the receiving encryption key and the manifest signing key. A signed-in user learns the same for the addresses they look up. Validators learn nothing from it | sees the IP and session of publishers and lookers |
| Deposit gateway and its chain (one-wallet flow; decision 0013) | sees the depositor's 0x address | sees the amount | sees block times | | sees `rho`, a hiding commitment to the destination account; **does not learn the account**. The public link is `0x depositor -> rho -> mint position`; which account claims that position is hidden by the receive proof, up to amount-and-timing correlation | |
| Backup service (in the node; decision 0012) | **sees** the 0x address that uploads | | sees upload times and ciphertext sizes | | ciphertext only: the backup key is derived from a wallet signature or a recovery code that never reaches the node; the association it holds is `0x -> an encrypted blob` | sees IP and session |

## Trust boundaries and what each layer enforces

- **Circuit (R_op, R_dep)**: balance non-negativity and range, receipt inclusion, single claim per position (in the wallet's committed tree), correct commitment transitions, mint receipt amount.
- **Ledger STF** (`peal-bonsai::ledger`): namespace and circuit id match, signature by the account key, strict decoding (canonical field elements, on-curve and in-subgroup points) before pairings, old commitment equals current, revealed root within the window, proof verifies, deposit id unique, atomic write, chained state root, full replay.
- **Wallet**: refuses double claims, overdrafts, receipts not addressed to it, openings that do not match the served leaf and root; journals every transition before submission.
- **Gateway contract** (`contracts/src/links/PealLinksGateway.sol`): ERC-20 allowlist, exact-amount transfers (fee-on-transfer refused), threshold ECDSA certificate over an EIP-712 message bound to chain id, gateway address and signer epoch, unique withdrawal ids, per-token caps, pause, reentrancy guard, owner-only rotation, no sweep.
- **Watcher** (`crates/peal-links-node/src/watcher.rs`): verifies chain id and contract code before marking a namespace available; credits only events from the configured gateway and token, at least `confirmations` blocks deep, deduplicated by `chain:tx:logIndex`; detects a changed block hash under its cursor and rewinds; a deposit whose amount differs from its registered intent is never credited (recorded as `wrong_amount`).
- **Settlement** (`settlement.rs`): every signer checks the burn opening against the ledger leaf, the claim signature, and the account before signing; positions are consumed exactly once by a primary key; the message names the gateway's current epoch.
- **Product API (Phase E)**: signed request manifests, EIP-4361-style session auth, idempotency keys bound to contents, rate limits, no secrets in logs.
- **Consensus** (`crates/peal-links-consensus`, decision 0010): a block is voted for only if its round, parent and height match the engine's context and every envelope passes the ledger's stateless checks (namespace, circuit, signature, canonical encoding, proof against the claimed commitment); a mint is voted for only if the validator's own RPC shows the deposit event, from the configured gateway and token, with the intent's amount and receipt, `confirmations` deep. Application at finalization goes through the same ledger code and re-verifies every proof, so a validator set cannot make the ledger accept what the STF refuses; it can only choose the order. Blocks and transactions are identified by the hash of their bytes; genesis binds the circuit id and the namespace set.
- **Distributed settlement** (`sign_for_peer`): a validator co-signs a withdrawal only after `SignerPolicy::check` against its own replicated ledger, after matching the message to the claim and to its own namespace configuration, and after reading the gateway epoch from its own RPC; it records the digest it attested per position and refuses a different one.

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

## Threats added in Phase F, validator mode (with the test or probe that exercises them)

| Threat | Enforcement | Exercised by |
|---|---|---|
| A leader proposes a block with an invalid proof, a bad signature, a foreign namespace or a wrong circuit | Every validator runs the ledger's stateless checks on every envelope before voting (`State::check_block`); the block gets no quorum | `four_validators_agree_on_the_ledger` (tampered proof refused before the mempool, so it is never proposed); the same checks run on peer-received transactions |
| A leader proposes a mint for a deposit that did not happen or has not confirmed | The proposer's own oracle must confirm before the mint enters its mempool; every voter's own RPC must confirm before it votes; a chain that cannot be reached makes the voter abstain | `four_validators_agree_on_the_ledger` (unconfirmed mint never finalized, confirmed one is); `ChainOracle` checks tx receipt, log index, gateway, token, amount, receipt commitment and depth |
| Validators diverge (different ledgers after the same blocks) | Application only at finalization, in block order, through the same ledger code; per-validator state root in `GET /links/v1/consensus` | `stack.sh consensus` after every suite and after restart and fault probes (identical heads and roots); `verify_replay` on one validator reproduces the root |
| A validator misses blocks (offline, late) | Backfill by digest from peers; ancestors of a finalized block are applied in order | `a_validator_that_missed_blocks_catches_up_by_digest`; fault probe `stop-node 2` / `start-node 2` |
| A peer floods or sends garbage on the p2p channels | Authenticated p2p (ed25519 handshake, per-channel rate quotas, 1 MiB message cap); decoders reject malformed frames; oversized blocks and transactions refused; block cache, mempool and concurrent admission checks are capped; unsolicited blocks outside a window ahead of the head are ignored; waits for blocks nobody supplies expire | `a_flooding_peer_cannot_fill_caches_or_stall_the_chain`; junk bytes and an HTTP request to the p2p ports while the chain advanced (Gate F addendum) |
| A validator's settlement signer is asked twice for one position (a second recipient) | Every signer, requester included, records the digest it attests per position and gateway epoch before signing and refuses a different one; the gateway consumes the withdrawal id once | `attest` in settlement.rs; bridge suite (replay refused on chain) |
| The gateway's signers are rotated after a certificate was issued | `settle` re-certifies under the new epoch instead of returning the dead certificate; attestations are keyed by epoch | code path in `settle`; not exercised on the local stack (no rotation script) |
| A validator's settlement key signs for a withdrawal its ledger does not hold | `sign_for_peer` runs `SignerPolicy::check` against the local replicated ledger, matches the message to the claim and the namespace, reads the epoch from its own RPC, records the attested digest per position | bridge suite on the validator stack (two peer co-signatures logged after checks); first-round refusal and retry observed in the logs |
| One of three validators is down | Consensus halts (no quorum); API submissions answer with a storage error after their deadline, never a fake success | fault probe evidence |

## Threats added by the one-wallet addendum (decisions 0011 to 0013)

| Threat | Enforcement | Exercised by |
|---|---|---|
| The directory serves a substituted receiving key or profile | The sender verifies the profile's EIP-712 signature against the 0x address it typed (EOA by recovery, contract wallets by ERC-1271 on the named chain), the ledger domain and expiry, and that a payment link's manifest is signed by the profile's `profileKey` | one-wallet browser suite: a tampered profile is refused |
| Directory rollback or withholding | Append-only hash chain per address; a client that saw version n refuses an older one; expiry bounds staleness | node unit test on the directory log |
| Phishing for the recovery signature | Any site can request the same `personal_sign`; the message names Peal and its purpose, the setup step warns, and the optional recovery code wraps the derived key so a stolen signature alone opens nothing. The signature is never transmitted or stored | setup copy; recovery-code test |
| A wallet that signs the recovery message non-deterministically | Sign twice at setup and compare; if they differ the derived-key path is not offered and the recovery code is required | setup logic; contract-wallet stand-in in the browser suite |
| Backup rollback | The node refuses uploads with a lower state version; restore reconciles against the ledger and refuses to spend from a stale snapshot | recovery test on a fresh browser |
| A payment intent replayed or forged | It is local: verified in the client against the connected address before proving, bound to amount, recipient profile hash, request id, ledger domain, account state version, nonce and expiry; never transmitted, so nothing to replay against | checkout logic |
| Paying an address that never activated private receiving | No profile means no receiving key: the invitation state moves no funds and creates no account | one-wallet browser suite, criterion 8 |

## Not protected (stated plainly)

- Which account acts, and when, is visible to the ledger and anyone reading its log.
- Deposit and withdrawal amounts and EVM addresses are public.
- Submission metadata (IP, timing) can link operations to people.
- The node learns which 0x address owns which Bonsai account (directory, request creation, backups). The interface hides the machinery; it does not make the wallet and the private account cryptographically unlinkable, and the landing page says so.
- The ledger operator can censor or delay. In single-node mode that is one process; in validator mode the leader of a view chooses what to include and a set of three validators tolerates no faulty member (four would tolerate one). All validators run on one machine under one operator: the consensus path works, the decentralisation does not exist yet.
- The settlement committee can release reserves incorrectly if a threshold of signers is compromised (decision 0005). Locally the committee is either a single-process fixture inside the node or one key per local validator process; neither is independent custody.
- Consensus liveness depends on every validator's chain view: a validator whose RPC lags votes against mints it cannot confirm, and one whose RPC is down abstains. Three validators with one abstaining cannot finalize.
- The gateway owner can rotate the signer set, so the owner key is equivalent to the committee after one rotation; production needs a timelock and multisig on it.
- Deposits credited under the confirmation policy and later reorged away are the accepted risk of that policy.
- Simulation extractability of ZK-Pari is asserted, not proven (RESEARCH.md); a passing test suite does not change that.
- No formal review of this integration has taken place.
