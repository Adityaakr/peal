# Peal Links build spec

Bonsai-backed private payment links inside Peal Network. This file is the single source of truth for the build. It is written for Claude Code working autonomously across many sessions and many context windows.

Research observations in this file were checked on 15 and 16 September 2026. Verify their current status before relying on them.

---

## 0. How this spec is used

**Where things live**

- `CLAUDE.md` (repo root): standing rules, loaded every session. Kept short.
- `docs/peal-links/SPEC.md`: this file. The full requirements.
- `docs/peal-links/BUILD_STATUS.md`: the living log. Current phase, plan, decisions, gate evidence, blockers, and the exact next step.
- `docs/peal-links/decisions/`: one short decision record per material choice.
- `docs/peal-links/evidence/`: screenshots, benchmark output, and test logs referenced from gate records.
- `docs/peal-links/RESEARCH.md`, `ARCHITECTURE.md`, `THREAT_MODEL.md`, `DESIGN.md`, `OPERATIONS.md`, `BENCHMARKS.md`, `MAINNET_READINESS.md`: written during the build.

**Session protocol**

1. Start of every session: read `CLAUDE.md`, then `BUILD_STATUS.md`, then the section of this spec for the current phase. Run the smoke command recorded in `BUILD_STATUS.md` to confirm the environment still works. Continue from "Next step". Do not re-plan from scratch.
2. During a session: update `BUILD_STATUS.md` whenever a gate closes, a decision is made, a blocker is found, or before starting any command likely to run longer than ten minutes. Commit at every gate.
3. When context is getting long, or before any risky operation: write the exact next step, the currently failing test if any, and any half-edited file paths into `BUILD_STATUS.md`, then commit. The next session must be able to resume from that file alone.
4. Never end a session with the repository in a state that `git status` cannot explain.

**When something is blocked**

Continue all independent work. Never idle on a blocker, never ask a routine question, never fake around it. Record it in the blocker format in section 4 and move to the next feasible item.

---

## 1. Mission

Ship Peal Links: someone creates a payment request, shares its URL or QR code, receives a genuine private payment, and manages balances and receipts in a dashboard. A payer connects an EVM wallet, funds a private balance if needed, authorizes a payment, and gets an accurate confirmation. The receiver can be offline when the payment is sent and claim it later.

The deliverable is working code: real cryptographic send and receive proofs powering the flow, a reproducible local stack, genuine end-to-end tests, measured performance, and honest production activation documentation. Not a frontend mockup, not an architecture document, not a demo with a hidden trust substitution.

---

## 2. Fixed decisions

These are not open for reconsideration.

- Brand is **Peal** (not Peel). Product is **Peal Links**.
- Logical routes: landing `/bonsai`, authenticated app under `/bonsai/app`, public checkout `/pay/:requestId`. Adapt to the existing router without breaking existing links. If the project uses hash routing, keep it unless the hosting configuration demonstrably supports history fallback. Whichever you keep, copied links and deep links must survive a refresh. Document the actual URLs. Add a restrained "Payments" navigation item.
- Cryptographic foundation is **Commonware's Bonsai payment construction with its ZK-Pari implementation**. Not RAILGUN, not a mixer, not a stealth-address-only system, not an ordinary ERC-20 transfer, not a SQL balance table, not an encrypted database with the word Bonsai on it. Do not confuse this with RISC Zero's Bonsai service or any other similarly named project.
- A configurable family of EVM funding and withdrawal networks: Ethereum, Base, and Arbitrum profiles plus reproducible local and test configurations. Never hardcode one chain through the system. Configured is not deployed, tested, funded, or available. The UI shows only operational routes as payable.
- Backend for Bonsai, Commonware, and ledger work is Rust. The application boundary is a typed TypeScript SDK. Use the repository's existing database; if none exists, PostgreSQL for app metadata and durable delivery queues. Ledger state stays separate from presentation data.
- Initial default: fixed-amount, single-payment requests. Reusable or flexible-amount links come only after the default flow is correct, and only as additional options.
- Out of scope for this build: auctions, lending, swaps, subscriptions, fiat onramps, a new token, forced timelock features. Unsupported features never appear as active controls.
- No real funds spent, no production transactions broadcast, no live contracts replaced, nothing published over the existing site. Prepare deployment artifacts and scripts instead. Use existing project permissions and explicit deployment authorization only if they already exist; otherwise finish all local work without asking.

---

## 3. What counts as real

Read this before every gate. "Done" means the following, in default mode, with nothing switched on by a demo flag.

- **Real proof**: generated by the pinned ZK-Pari send or receive circuit from a witness derived from actual wallet state, and verified by the same verifier code path the ledger uses in production mode. A verifier that returns true, checks a hash, or skips subgroup validation is not a verifier.
- **Real ledger transition**: the durable ledger store's state root changes, the transition is replayable after restart, and a conflicting or invalid operation is rejected by the state transition function itself, not by the API layer.
- **Real deposit**: an ERC-20 transfer observed on a local EVM node through the gateway contract's events by the watcher, credited only after the configured confirmation policy, deduplicated by full event identity and chain domain. A frontend callback is not a deposit.
- **Real withdrawal**: a finalized private debit on the ledger, a certificate from independently keyed signers, and a gateway contract that verifies the certificate and moves the tokens. The local fixture that holds all signer keys in one process is labeled as such everywhere it appears.
- **Real end-to-end test**: two separate browser contexts driving the actual local stack, from request creation through claim to withdrawal.
- **Not real**: in-memory stubs, fixtures, mocks, `if demo then succeed` branches, or any test double reachable from the default demo path. Test doubles live in narrow unit tests only.

Every place where reality is not yet achieved is isolated behind an explicit, default-off configuration and recorded as a blocker.

---

## 4. Working rules

**Autonomy**

- You are the principal product designer and the protocol and full-stack engineer. Make routine product and engineering decisions yourself: frameworks, naming, layouts, defaults, order of work. No routine clarification questions.
- If a choice is reversible, pick a sensible default and implement it. Write material architectural choices as short decision records in `docs/peal-links/decisions/`.
- Prefer the repository's existing frameworks, package manager, auth, database, deployment conventions, components, and tests. Add dependencies only for concrete needs.
- Inspect repository instructions, existing infrastructure, and credentials already legitimately configured for this project. Preserve unrelated work and all existing Peal functionality.
- Missing optional external services must not stop local work. Supply local alternatives, an environment template, and actionable deployment instructions.
- Never invent secrets, deployed addresses, API capabilities, or successful test results.

**Honesty**

- Never fake functionality. Never substitute a different trust model quietly. Never weaken cryptography, skip signature validation, disable or loosen a test, or trust a server to make a demo pass.
- Never claim complete anonymity, metadata privacy, external review, formal proofs, or production readiness that has not been obtained.

**Git**

- Work on a branch `feat/peal-links` from the default branch (or follow the repository's existing branch convention). Commit at every gate and at natural checkpoints with clear messages, for example `peal-links(phase-c): receipt inbox with archive verification`.
- Never commit secrets, `.env` files, private keys, or generated key material. Put ignore rules in place before the first commit that could contain them.
- Never force-push, rewrite shared history, or merge into the default branch. Leave the pull request to the maintainer.

**Evidence**

- A gate is closed only by a record in `BUILD_STATUS.md` with: commit hash, exact commands, exit codes, test counts (passed, failed, skipped), paths to artifacts in `docs/peal-links/evidence/`, and residual risks. A gate without evidence is open.
- After each meaningful change: typecheck, lint, and run the tests for the touched package. Before a gate: run the full suite.
- Screenshots are taken, then inspected, then the problems are fixed. An uninspected screenshot is not QA.

**Blocker record** (in `BUILD_STATUS.md`, one per capability):

```
### Blocker: <capability>
Blocked: <what does not work in production mode>
Reason: <external requirement or unresolved security property>
Done instead: <executable local path and how it is labeled>
Isolation: <flag, module, or config that keeps it off by default>
Unblock requirement: <exact, actionable>
```

**Working style for Claude Code**

- Use subagents for parallelizable, self-contained work: reading and summarizing each research source, running long test suites while you continue implementing, independent visual QA passes. Subagents report; you decide. They do not make architectural choices silently.
- Before each phase, write a short plan (five to fifteen lines) into `BUILD_STATUS.md`, then execute it. Adjust the plan in the file when reality differs.
- Keep long-running services under docker compose or the repository's process manager so they survive across tool calls. Record how to start, stop, and reset them.

---

## 5. Research phase, with a hard stopping point

Read these primary sources and follow relevant implementation references. If the Commonware MCP server is configured in this session, prefer it for version-aware API lookups; otherwise use `llms.txt` and pinned source.

1. Peal: https://peal.network/ and this repository, which is the source of truth for current design and behavior.
2. Bonsai article: https://commonware.xyz/blogs/private-payments
3. Paper: https://eprint.iacr.org/2026/1987 (PDF: https://eprint.iacr.org/2026/1987.pdf)
4. Prototype PR: https://github.com/guruvamsi-policharla/zk-pari/pull/2
5. Prototype repository: https://github.com/guruvamsi-policharla/zk-pari
6. Commonware Library: https://github.com/commonwarexyz/monorepo, or whatever Commonware's current site links if this moves.
7. Version-aware discovery: https://commonware.xyz/mcp and https://commonware.xyz/llms.txt
8. EIP-712, ERC-1271, EIP-4361, ERC-20 at https://eips.ethereum.org
9. Current official documentation for the chosen Ethereum, Base, Arbitrum, wallet, proving, and deployment tooling.

**Observed on the research dates** (starting points, not instructions to use stale revisions)

- The zk-pari PR was open with head `a8266aac58314214552a214fead1c0258f8de418`. Package `zkpari`, feature `circuits`. Files seen: `src/circuits/send.rs`, `recv.rs`, `op.rs`, `smt.rs`, `merkle.rs`, `src/batch_verify.rs`, `benches/throughput.rs`. Check for a newer reviewed implementation, inspect diffs, choose a revision explicitly, pin it with lockfiles, and record provenance. Do not assume the default branch contains the payment implementation.
- The Bonsai post ("Out of Sight, Out of State") went live on commonware.xyz around 12 September 2026. The paper is ePrint 2026/1987, "Bonsai: Scalable Private Payments".
- The public Peal deployment appeared to be a single-page app with hash routing, a Rust-to-WASM `peal.js` SDK, and a coordinator API under `/v1`. Verify against the repository; do not design from these observations.

**Deliverable: `docs/peal-links/RESEARCH.md`**

- Source URLs, retrieval dates, code revisions, licenses, toolchain, build commands.
- What Bonsai does; which parts exist as code; which parts Peal must implement.
- A mapping from each cryptographic operation to actual upstream files, functions, and tests.
- Security assumptions, setup requirements, unresolved proof obligations, and every change Peal introduces.
- Benchmark scope and what is not measured.

**Stopping point**

Research ends when all three are true: an upstream circuit test has been reproduced locally at the pinned revision; `RESEARCH.md` exists; the concrete missing integration pieces are listed. Then implement. Do not spend the run researching or writing plans. If the upstream tests cannot be built after a reasonable effort, record the exact failure as a blocker, pin the revision anyway, and proceed with the deterministic vertical slice.

### Facts to preserve

- "Bonsai" is the scheme's name, not an acronym established by these sources. The paper connects the name to keeping active tree state small through pruning. Do not invent an expansion.
- The construction commits each account's balance and its private claimed-receipt tree root. Send creates a hiding receipt. Receive proves ownership, receipt inclusion, correct balance change, and insertion of a previously unclaimed receipt position into the receiver's private sparse Merkle tree. Validators enforce transitions against the current account commitment and store no nullifiers. Receipts are authenticated by a Merkle Mountain Range. Wallets keep their own nullifier history and can move older portions to cold storage. History is redistributed, not erased.
- Use the operation-hiding relation when supported: send and receive share a public record shape and append real or unspendable dummy receipts. The acting account remains visible; observers cannot see amounts, counterparties, or direction. Submission metadata (RPC sessions, IP, timing) can still link operations to users. Never claim complete anonymity, metadata privacy, or concealment of all account activity.
- Published numbers from the paper, observed 16 September 2026: proofs are `128 bytes`; a single verification is about `0.7 ms` (three pairings); a batch of `2^16` proofs verifies at about `11.7 µs` amortized per proof; about `1.05M` proof verifications per second on an 18-core M5 MacBook Pro, which is roughly `525K` payments per second because a payment is one send plus one receive. This is batched verification throughput, not an end-to-end production blockchain measurement, and it excludes some parsing and subgroup-validation costs. Do not put these numbers on Peal's landing page as Peal performance. Measure the Peal implementation separately.
- The paper's Remark 2 states the payment protocol needs simulation extractability and defers a formal proof for the ZK-Pari instantiation. Check whether later work resolves this. A passing test suite does not resolve a missing security proof. Report the current status accurately.
- Bonsai does not supply stablecoins, a running network, an EVM bridge, production setup parameters, recipient routing, browser proving, selective disclosure, or recovery. Build those explicitly or mark the relevant production capability unavailable.

---

## 6. Product scope

Ship these connected experiences:

1. Product landing page in Peal's current theme.
2. Wallet connection and private account onboarding and recovery.
3. Create, preview, share, manage, and archive payment requests.
4. Public checkout with genuine quote, funding, payment, and error states.
5. Private dashboard: available funds, incoming unclaimed funds, sent and received records, request statuses.
6. Add funds and withdraw through chain-specific adapters.
7. Encrypted receipt inbox, manual claim, and auto-claim while the receiver's unlocked client is online.
8. Export and import of an encrypted account backup; restore on another client.
9. A small typed SDK used by the application itself and documented for reuse.
10. Reproducible local deployment, genuine end-to-end tests, measured performance, production activation documentation.

---

## 7. Design

### Inspect and reuse Peal first

Before designing anything, inspect the existing logo assets, CSS tokens, fonts, navigation, buttons, cards, layout widths, responsive behavior, icons, and motion. Capture the existing landing page and app in a browser when possible. Read the real source styles rather than approximating the logo or guessing brand colors.

Fallback observations from the public CSS (not permission to override newer repository tokens):

- Accent `#2563eb`, stronger accent `#1d4ed8`.
- Text `#111827`, muted `#6b7280`, border `#e5e7eb`.
- Warm surface `#fbf8f3`, warm border `#e7e2d9`.
- Display family Josefin Sans. Body DM Sans or Satoshi. Existing monospace for technical labels.

Do not use an old red Peal palette. Do not invent green branding because the product uses Bonsai. Reuse the real Peal mark, unobstructed, at correct proportions.

### Landing page (`/bonsai`)

A restrained, finished payments product page:

- Existing Peal header, new Payments navigation item, small "Peal Links" product label.
- Hero: **"One link. A private payment."**
- Supporting copy: **"Create a payment request, share it, and receive funds in your Peal balance."** Adjust copy to supported behavior and environment; never imply production availability in test mode.
- Primary action "Create a payment link". Secondary action "How it works".
- Beside the hero, an interactive and explicitly illustrative checkout or receipt preview using fictional data. It must not resemble live network metrics or real customer activity.
- A compact explanation of request, pay, and receive.
- Three use cases: independent work, business invoices, contributions.
- A clear privacy explanation: what the public sees, what counterparties see, what Peal's services can see.
- A small developer section describing the implemented SDK with a real working example, not invented APIs.
- FAQ: supported networks and assets, why a private balance is needed, receipt claiming, recovery, fees, deposit and withdrawal visibility.
- Existing footer and unobtrusive Commonware and Bonsai attribution. No implied endorsement or partnership.

### Dashboard and checkout

- Dashboard: calm, with functional information density. Balances, primary actions, request list, activity list, clear status details. No decorative charts, invented revenue, empty widgets, or a generic admin-template grid.
- Checkout feels like a payment request, not a block explorer. Show payee identity with its actual assurance level, description, amount, asset and network context, total fee, and a single appropriate next action. A self-chosen display name is not a verified identity badge. Wallet switching, insufficient balance, expired request, unsupported network, and transaction rejection are all recoverable states.
- Public checkout works without connecting a wallet until payment is initiated.

### Motion and accessibility

- Subtle CSS or SVG linework and payment-card transitions. Existing animation libraries or plain CSS. No unnecessary WebGL. Honor reduced-motion preferences.
- Interactions in the `120 to 240 ms` range, restrained entrance animations, stable layout, no endless decorative movement during proof generation. Status animation reflects a real pending operation; never manufacture progress percentages.
- WCAG AA contrast and keyboard behavior. Visible focus, accessible dialogs, labeled errors, readable amount formatting, text alternatives, touch-sized controls.
- Test at roughly `360 to 390 px`, tablet, and desktop.

---

## 8. Flows and semantics

### Recipient onboarding

- Connect an existing EVM wallet, authenticate with a domain-bound challenge signature (EIP-4361 style, with nonce and expiry), then create or restore a private Peal account.
- Keep four things separate: EVM ownership, private spending authority, encryption keys, recovery material. Connecting an EVM wallet alone is not recovery of private Bonsai state.
- Generate secrets with reviewed cryptographic libraries and operating-system or browser randomness. Never derive spending keys from a publicly visible signature, address, request ID, email, or weak password. If a password encrypts a backup, use a reviewed password KDF and authenticated encryption with explicit parameters.
- Offer a concise recovery setup before funds can be received. Explain what happens on a new device and after browser storage loss.
- Preserve existing Peal authentication; keep payment authorization distinct from it.

### Create a request

- Fields: title or description, exact amount, supported asset and domain, optional expiry, optional reference, display name, optional encrypted note. Integer base units only, never floats. Preview checkout and visibility before publishing.
- A default request binds a specific receiving identity and asset domain. It does not silently accept an economically different asset because the symbol matches.
- Unguessable identifiers. URLs carry no spending keys or receipt openings. Link data and QR payload must match.
- The receiver signs a canonical request manifest: version, network or ledger domain, asset identity, receiving-account binding, amount constraints, expiry, request ID. The payer verifies it before paying. Editing critical payment fields produces a new signed version; stale quotes cannot redirect funds.
- "Unlisted" means possession of the URL grants access to displayed details, not that the details are cryptographically secret. Keep public descriptions free of sensitive information by default. Never put amounts, names, request IDs, or private notes into third-party analytics. Set `noindex` and a conservative referrer policy on checkout.

### Payer checkout

Open URL, validate manifest, connect wallet, select an actually supported funding route, view total and privacy details, authenticate or unlock private account, fund if needed, generate proof locally, submit, verify acceptance, deliver encrypted receipt, display accurate status.

- A first-time payer needs private account setup and recovery too. Do not hide that dependency. Existing funded users get the shorter path.
- Wallet approvals require user signatures. Autonomous implementation is not permission to bypass wallet confirmation.
- Committed funding and an incomplete private transfer must be resumable. Never ask for a second deposit because the browser lost a response. Persist intent IDs before irreversible operations. Quote revisions and expiry are explicit.

### Receive and claim

- The sender's accepted operation creates a receipt; it does not immediately update the receiver's spendable balance. Store and deliver the encrypted receipt package reliably. The receiver retrieves it, verifies it against authenticated ledger state, proves receive, and obtains spendable funds.
- With an unlocked client, auto-claim only under an explicit session preference. Offline or locked: show as unclaimed. Never upload private spending material to a server to simulate offline auto-claim.
- Bonsai does not tell the sender when a receipt is claimed. Claim or read acknowledgments are optional, recipient-signed disclosures. Do not create a globally visible receipt-to-claim index that defeats the construction's privacy.

### Status model

Model request, payer operation, receiver claim, deposit, and withdrawal separately.

- Request: draft, active, locally reserved, fulfilled, expired, archived.
- Deposit: awaiting signature, submitted, included, sufficiently finalized, credited, reorged, failed.
- Payment: preparing, proving, submitted, accepted, receipt delivery pending, receipt delivered, rejected.
- Receipt: discovered, verified, unclaimed, claiming, claimed, invalid.
- Withdrawal: requested, private debit finalized, certificate or proof ready, EVM submitted, confirmed, failed or retryable.

Cancellation or request expiry prevents new authorized checkout attempts; it does not reverse an accepted payment. Browser closure is not cancellation. Never label sender acceptance as receiver claim, or L2 inclusion as Ethereum finality.

### One-time request consistency

- Concurrent payers must not produce a falsely "exactly once" request. Implement idempotency per payment intent and, if enforcing one-time requests, an atomic request-fulfillment authorization at ledger admission. Analyze the metadata cost of revealing a request commitment to admission services. A backend database lock cannot atomically govern ledger payment acceptance.
- If protocol-level enforcement is unavailable, disclose the exact weaker behavior and treat duplicate payments as real funds requiring a separate refund action. Never discard them or invent automatic reversals.
- Binding a payment to a request and returning an acceptance certificate requires a specified cryptographic relation. A sender-signed label or backend assertion alone is not evidence that the receipt contains the expected recipient and amount. Document any extra ZK relation, selective opening, or operator visibility introduced for checkout reconciliation.

### Dashboard semantics

- Per asset domain: available balance, verified unclaimed incoming funds, sent payments, received payments, request statuses, funding progress, withdrawals. Never add unlike assets into a fabricated USD total.
- Real timestamps with local formatting, searchable requests, copy and share actions, useful empty states.
- Private histories are decrypted on the user's client. Export a receipt or CSV only on explicit action, with a warning about newly disclosed data. Notifications outside the app are opt-in and omit sensitive details.

---

## 9. Architecture

Extend the existing web app. Logical components, adapted to the actual repository layout:

- **Bonsai core**: pinned upstream primitives plus reviewed integration code.
- **Prover**: browser worker or WASM if feasible, with native parity tests.
- **Ledger**: deterministic state transition function, authenticated account state, receipt MMR, recent-root policy, durable storage, Commonware consensus integration.
- **Delivery and archive**: encrypted recipient inbox, inclusion-proof serving, replication, retries.
- **EVM adapters and contracts**: funding observation, deposits, withdrawals, deployment manifests.
- **Product API**: signed request manifests, public checkout data, authenticated metadata, idempotency, rate limits.
- **SDK**: typed wallet, proof, request, funding, payment, claim, receipt, and withdrawal interfaces.
- **Frontend**: landing page, checkout, dashboard, recovery, settings.

Consensus and ordering:

- Implement deterministic transitions before attaching consensus. Use a real multi-node local Commonware deployment where practical. Single-node mode is a development convenience, never a decentralized production claim.
- Transactions in a proof batch can conflict on the same old account state. Batch proof validity does not authorize applying conflicting state transitions. Resolve ordering against current commitments deterministically.

### Proving and transport

- Benchmark the actual payment circuits, not only a synthetic squaring circuit.
- Attempt a browser worker or WASM build. Known constraint to handle: upstream parallelism (rayon) needs WASM threads, which need `SharedArrayBuffer`, which needs cross-origin isolation headers (`COOP` and `COEP`) from the host. Check whether the existing hosting can set them. If not, ship a single-threaded WASM build or a native prover path and record the tradeoff.
- Keep expensive work off the UI thread, cache fixed proving data by authenticated version, and permit interruption before submission.
- If browser proving is blocked, implement a genuine local native prover plus transport for development and record the production-browser blocker. Never silently send witnesses or account openings to a remote prover. A remote proving mode, if provided for development, is labeled with its trust consequences and disabled by default.
- Network decoding validates canonical encodings, field bounds, point validity, and subgroup membership. Limit payload sizes and work budgets before expensive verification. Randomize batch verification as the construction requires. Isolate invalid proofs so one adversarial batch cannot block everyone indefinitely.

### Private state and recovery

- Persist account openings, balance witnesses, private nullifier state, randomness, encrypted receipts, and outbox information durably, with atomic local updates and authenticated ledger checkpoints.
- A send acknowledgment must survive a crash before local persistence. Design a recoverable journal or outbox with a retry protocol.
- Fresh-device recovery restores private state, not only the EVM key. Store encrypted, versioned backup snapshots and required deltas. Define anti-rollback behavior and concurrent-device conflict resolution. Secrets never enter URLs, logs, crash reporters, analytics, or ordinary backend tables.
- Provide receipt-proof refresh from an archive for returning users. Define data retention, redundancy, and availability guarantees. An MMR root authenticates historical data but cannot reconstruct missing ciphertexts or private witnesses. Test delayed receipt claims below the wallet's pruning threshold using retained archive paths.

### Local defaults (use only where the repository has no equivalent)

- Local EVM: two Foundry `anvil` instances with distinct chain IDs as the two backing domains, and Foundry for contract build and tests. If the repository already uses Hardhat, use Hardhat.
- Browser tests: Playwright with two isolated browser contexts.
- WASM: `wasm-pack` or `wasm-bindgen` with an explicit target and feature set.
- Services: docker compose (or the repository's process manager) with health checks, plus one script (`make demo` or the repository's task runner) that brings up the stack and exercises the full flow.
- Database: PostgreSQL if none exists.

---

## 10. EVM networks and asset backing

- Network configuration is validated data: chain ID, RPC endpoints, explorer URL, finality strategy, supported token contract and decimals, gateway deployment, code hash or version, limits, ledger domain, availability status. Reuse vetted chain definitions. Verify addresses against official sources or onchain code. Never infer a token address or decimals from a ticker. Arbitrary user-entered RPCs or contracts never become trusted network definitions.
- Adapters for Ethereum, Base, and Arbitrum plus at least two local EVM environments. Execute real deposit and withdraw flows on both local environments. Mainnet profiles may be present but stay unavailable until deployment and configuration are verified.

**Default asset model: isolated backing domains.** An asset is identified by source chain, token address, gateway, and ledger namespace. Same-symbol assets on different chains are not fungible. A Base-backed balance withdraws to Base; an Ethereum-backed balance withdraws to Ethereum. No cross-chain redemption and no aggregated spendable balance unless a real liquidity, rebalancing, and redemption mechanism is built and tested.

Prefer isolated single-asset Bonsai ledger namespaces initially to minimize changes to the payment circuit. Bind every operation, signature, receipt-delivery record, and certificate to its namespace to prevent cross-domain replay. Never add an unauthenticated external asset label to a proof and call that multi-asset security. Hiding transfers within a namespace does not hide which namespace is used.

### Deposits

- The gateway observes actual tokens received, not a successful client submission. Start with a verified allowlist of ordinary token implementations; handle nonstandard return values with established safe-transfer tooling. Reject fee-on-transfer and rebasing behavior. Check balances, allowances, receipts, contract identity, token precision, and chain ID.
- Credit a deposit only after the configured chain-specific confirmation or finality policy. Deduplicate by full event identity and chain domain. Model reorgs and L2 settlement assumptions explicitly. Never mint private value from an unverified frontend callback. Persist watcher cursors and replay safely after restart.
- Deposit amounts and source wallets are public at the EVM boundary. Identify what the gateway or observer learns about the destination private account, even when the public does not. Record all such leakage in the threat model.

### Withdrawals and settlement trust

- A Bonsai send or receive proof does not by itself authorize minting or releasing an ERC-20 on another chain. A withdrawal must consume private value exactly once and produce evidence the EVM gateway actually verifies. Implement a domain-bound withdrawal relation or a documented extension with a debit or burn invariant. Never destroy recoverable funds by inventing a pretend burn address.
- For the initial executable implementation, a threshold-attested gateway is acceptable **only as an explicitly labeled committee-trusted model**: the Commonware ledger finalizes a withdrawal debit, independently configured signers attest to its canonical withdrawal message, and the gateway verifies threshold authorization, epoch, chain, contract, asset, recipient, amount, and unique withdrawal ID. Store consumed IDs and reject duplicates. Separate signing keys; one process holding all keys is only a local test fixture. State directly that a compromised threshold can authorize invalid releases.
- Never call this bridge trustless, ZK-settled, or rollup-secured when it verifies committee signatures. A proof-verified settlement adapter needs additional aggregate or state-transition and data-availability design; do not substitute a hash or mock verifier. Explain the upgrade path without claiming it is implemented.
- Implement bounded withdrawals, explicit pause behavior, signer rotation and epochs, reentrancy protection, replay protection, correct ERC-20 transfers, and tested failure recovery. No unilateral admin sweep, no silent balance rewriting. If the operator disappears, state whether users can exit and exactly what data and cooperation they need. No unsupported "funds always recoverable" claim.
- Global accounting per backing domain reconciles gateway reserves with private balances, outstanding unclaimed receipts, and pending withdrawals, accounting for fees without counting claims twice. Ledger metadata may track aggregate liabilities; it never replaces proof-enforced user balances.

---

## 11. Privacy and authorization

- Write an observer matrix in `THREAT_MODEL.md` covering public EVM observers, Bonsai validators, RPC operators, Peal's request API, delivery and archive services, counterparties, and backup storage. For each: known addresses, amounts, timing, request IDs, account associations, network metadata.
- Do not casually expand the native Bonsai guarantee to the application. Checkout URLs, funding routes, request registration, account authorization, and delivery lookups can reveal relationships. Be precise about these additions and minimize retained metadata.
- Separate receiving encryption keys from spend authority. Prove or authenticate recipient key ownership and binding; a backend directory must not be able to silently replace the recipient. Handle key rotation and historical requests explicitly. An EVM address is not an encryption key.
- Domain-bound authentication and signed authorizations with nonces, expiry, and chain and application context. EIP-712 alone does not prevent replay. Verify EOA signatures and ERC-1271 contract-wallet signatures where supported; smart-wallet validity is chain and state dependent. Disable unsupported smart-wallet paths with an honest explanation rather than treating them as EOAs.
- Authenticated encryption with contextual associated data and fresh nonces for receipt and backup transport. Receipts are recipient-bound, not bearer links. Prove correspondence between credited amount and receipt; reject tampering. Authenticate the ledger root and finality evidence before accepting an archive proof.
- Application security: request authentication and authorization, CSRF protection where relevant, safe sessions, strict input validation, XSS protection, restrictive CSP, rate limits, query limits, private caching headers. Exclude spending secrets, receipt openings, balances, and plaintext sensitive notes from server logs and telemetry. Record operational metrics without full request or account identifiers.
- Never use plaintext receiver data or side endpoints to undo operation hiding at the consensus layer. Product admission or reconciliation that necessarily exposes more is documented separately. Public payload formats and circuit versions are explicit.

---

## 12. SDK, APIs, operations

- A coherent typed SDK actually used by the frontend: account creation, unlock, and recovery; request creation and resolution; quotes; funding; private sends; inbox retrieval; claim; receipt export; withdrawals. Choose names after inspecting existing conventions. Document inputs, outputs, error classes, retry behavior, and privacy consequences.
- API schemas and types generated from a shared contract or validated definitions. Monetary values are integer strings on JSON boundaries. Version canonical encodings, proof and circuit identifiers, manifests, and persisted wallet state. No accidental rounding in UI or serialization.
- Durable operation IDs and status endpoints or streams. SSE or websockets reconnect with cursor-based replay and authenticated access. Idempotency keys bind request contents; reuse with different contents fails. Unknown outcomes are resolved by lookup before resubmission.
- Retryable delivery queues with outbox semantics. A send accepted before receipt delivery is "delivery pending", never "failed, try paying again". Archive responses are untrusted until verified; availability failures never authorize inventing proofs.
- Health and readiness checks, graceful shutdown, database migrations, durable ledger recovery, backups, rate-limit configuration, secret redaction.
- Benchmark separately: watcher lag, proof generation, validation, ledger finality, delivery, claim, withdrawal.

---

## 13. Testing and evidence

Meaningful tests, not snapshots that reproduce implementation details. Required cases:

**Cryptography and ledger**

- Genuine valid send and receive with pinned Bonsai code.
- Operation-hiding real and dummy behavior; dummy receipts cannot be claimed.
- Insufficient balance, range overflow, negative or invalid encodings, wrong recipient.
- Duplicate receipt claim, stale account commitment, modified receipt or proof.
- Two individually valid proofs racing from the same old account state.
- Cross-namespace and cross-epoch replay.
- Invalid subgroup or canonical encoding; mixed valid and invalid proof batch.
- Claiming old receipts after pruning, account restore, and archive retrieval.
- Crash and restart around an accepted operation and the local wallet journal update.
- Conservation including pending receipts and withdrawals.

**EVM bridge**

- Deposit credited exactly once; duplicate logs; watcher restart; wrong token or network; reorg handling.
- Withdrawal requires a debit; duplicate withdrawal rejected; wrong recipient or domain rejected.
- Threshold certificate validation, stale signer epoch, duplicate signer, key rotation.
- ERC-20 transfer failure and retry, malicious reentrancy, pause behavior.
- Isolation across two EVM backing domains; no accidental cross-chain reserve consumption.
- Loss of bridge or ledger availability yields explicit pending states, not success.

**Product and browser**

- Two separate users in separate browser contexts: recipient creates link, payer funds and pays, receiver claims.
- Receiver offline during send, later claims from restored state.
- Encrypted backup restore on a fresh client with correct balances and witnesses.
- Wrong network, wallet rejection, insufficient funds including fees, quote expiry.
- Browser reload at every payment stage without duplicate deposits or payments.
- Concurrent payers on a one-time request, stale signed manifest, modified recipient.
- Incoming unclaimed versus spendable balance, receipt permissions, export correctness.
- Valid QR and copy links, route refresh, mobile layout, keyboard accessibility.
- No private witness in network requests or server logs in default mode.
- Existing Peal routes and functionality still work.

**Demo and evidence**

- The main demo uses real Bonsai proofs, real local EVM deposits and withdrawals, and real persistent ledger transitions. Demo funds are unmistakably labeled and cannot be confused with mainnet assets.
- Screenshots, inspected and then fixed: landing, onboarding, create request, payer checkout, pending funding and proving, payment accepted, receiver unclaimed and claimed, dashboard, recovery, error states. Fix clipped content, inconsistent theme, overflow, contrast, and misleading states.
- Performance: measure actual end-to-end latency distributions under a reproducible workload, including cold and warm proof setup, client hardware, batch size and wait, parsing, subgroup checks, network topology, and concurrency. Compare single operations with batches. Do not wait for huge batches under low load to reproduce a headline throughput number. Tune a bounded adaptive batch window and report latency and throughput tradeoffs. Stop tuning when a documented bottleneck requires architectural work. Never invent a target result.

---

## 14. Phases and gates

Work the phases in order. When a phase is blocked, continue with independent work in the same or later phases and record the blocker. Each gate closes only with the evidence record below.

**Phase A: discover and prove the foundation**
Inspect Peal; record design tokens and routes; pin source dependencies; run upstream Bonsai tests; define the threat model, asset domains, and settlement trust; implement the deterministic send and receive vertical slice.
Gate A: one genuine send and claim, plus one invalid proof rejected, on the persistent ledger.

**Phase B: design and navigation**
Full landing page and responsive application shell using actual Peal components. Clearly labeled fixtures only while services are being connected.
Gate B: usable routes, correct brand, inspected screenshots. This phase is not the end of the task.

**Phase C: wallet and private ledger**
Authorization, client proving, persistence, consensus and storage integration, inbox, archive verification, pruning and recovery, exact payment state transitions.
Gate C: two separate users pay and claim through real services, including an offline receiver.

**Phase D: funding and withdrawals**
Chain configuration, local gateway contracts, watchers, finalized deposit credit, private withdrawal debit, verified settlement certificates, two local EVM domains.
Gate D: real local tokens enter, move privately, and exit, with conservation and replay tests passing.

**Phase E: product integration**
Connect creation, checkout, dashboard, recovery, quotes, fees, statuses, receipts, and SDK to the real backend. Remove every reachable mock payment path.
Gate E: complete browser flow from request creation to withdrawal; interruption and retry tests pass.

**Phase F: production preparation and QA**
Deployment manifests and scripts, actual environment validation, migrations, observability, backup and restore, performance report, activation checks. Test compatible public testnets when configured, without spending real assets.
Gate F: a clean checkout runs the complete local flow with documented commands.

**Gate record format** (append to `BUILD_STATUS.md`):

```
### Gate <A-F>: <name>  [PASSED | OPEN | BLOCKED]
Commit: <hash>
Commands: <exact commands and exit codes>
Tests: <passed>/<failed>/<skipped> per package
Artifacts: docs/peal-links/evidence/<files>
Residual risks: <list>
```

**Mainnet is an explicit release state.** The build contains real deployment code and verified configuration structure, but no real-money feature is enabled by a cosmetic environment flag. Activation requires an actual deployed gateway identity, supported asset configuration, finalized-ledger health, settlement keys and policy, required setup provenance, and documented security review status. Outstanding cryptographic or bridge blockers stay visible in `MAINNET_READINESS.md`. Never claim external review, formal proofs, or production readiness that has not been obtained.

---

## 15. Deliverables, definition of done, handoff

Deliver in the repository:

- Integrated Peal Links landing page, checkout, dashboard, onboarding, and recovery.
- Bonsai-backed ledger and prover integration with private receipt delivery.
- Typed SDK used by the application, with working examples.
- EVM gateway contracts, adapters, and scripts for Ethereum, Base, and Arbitrum profiles and for local environments.
- A reproducible local stack and one command that exercises the complete flow with test funds.
- Pinned dependencies, licenses, versioned migrations, `.env.example`, and validated deployment manifests.
- Under `docs/peal-links/`: `RESEARCH.md`, `ARCHITECTURE.md`, `THREAT_MODEL.md`, `DESIGN.md`, `OPERATIONS.md`, `BENCHMARKS.md`, `MAINNET_READINESS.md`, `BUILD_STATUS.md`, plus `decisions/` and `evidence/`.
- Meaningful passing test results and inspected browser screenshots.

Not done because: the page looks finished, a build compiles, a mock transfer succeeds, or a synthetic proof benchmark runs. State exactly which backend and trust model the demo uses.

**Handoff format** (final section of `BUILD_STATUS.md`; factual and brief, with links to the detailed docs):

```
## Handoff
What works:
Run it: <commands>
Routes: <actual URLs>
Tested chains and modes:
Upstream revisions: <zk-pari rev, commonware rev>
Measured results: <link to BENCHMARKS.md, headline numbers with their conditions>
Screenshots: <paths>
Known limitations:
Blocking real-money activation: <exact external requirements>
Trust model of the demo:
```
