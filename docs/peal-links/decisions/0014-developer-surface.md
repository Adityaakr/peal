# 0014: The developer surface: three pages, a skill reference, no new API

Date: 2026-09-17. Status: accepted.

## What was asked

Make Peal Private Links usable by developers: document the HTTP API and the SDK end to end, with architecture diagrams, on the developers pages, and cover it in the agent skill.

## What was checked

Four explorers mapped the node's routes (`crates/peal-links-node/src/api.rs`, router at the end of the file), the SDK's public surface (`packages/links/src`), the developer-page conventions (`packages/explorer/src/docs.ts`, `pages/docs/*`, `prerender.ts`, `crates/bte-coordinator/src/pages.rs`, `skills/peal`) and the trust boundary an integrator must understand (`auth.rs`, `directory.rs`, `settlement.rs`, `THREAT_MODEL.md`). Their evidence sets were disjoint by construction; the one contradiction (the settlement signer set size) was settled by the live `GET /links/v1/status`: three signers, threshold two.

## Decision

1. **No new API.** The node already exposes everything a client needs under `/links/v1`; the SDK already calls it. "Adding APIs" meant documenting the ones that exist, honestly, and fixing what stopped a third party from using them: the CORS layer omitted `PUT`, so a page on another origin could not publish a profile or upload a backup (`api.rs`, `allow_methods`). Fixed. `viem` was a runtime import declared only as a dev dependency; it is now a peer dependency of `peal-links`.
2. **Three pages**, wired the same way as every other developer page (nav, router, prerender list, the coordinator's page table for meta, sitemap and `llms.txt`):
   - `developers/links`: the pieces (one static SVG sketch), the eight-step flow, who sees what, identity and recovery, the SDK in one block, what is deployed, what you are trusting.
   - `developers/links-sdk`: install from the repository (the package is not on npm), bootstrap, the wallet signer and everything it signs, sessions, the account and every method, a payment end to end, encodings, Node.js, errors.
   - `developers/links-api`: conventions and encodings, the three authentication mechanisms with the sign-in domain caveat, every route grouped by area with fields, codes and idempotency, the error format, the limits, CORS. Two examples run against the live node from the page (`runner.ts`), because a sample nobody executed is a claim.
3. **One skill reference**, `skills/peal/reference/links.md`, indexed from `SKILL.md` (triggers, a section, the file list, the trust model) and the installer. The agents page and `llms.txt` name it.
4. **What the pages refuse to say**: trustless, ZK-settled, unlinkable, mainnet, "the node cannot forge" without the soundness caveat, contract-wallet support (sessions are EOA-only, so the ERC-1271 path in the directory is unreachable over HTTP today), and that the request reservation prevents double payment (it is a courtesy between payers).

## Verification

- A grounding verifier re-opened the source behind roughly 150 claims and found 12 discrepancies; all were applied (sign-in missing from every example, contract wallets, the SDK's 5xx mapping, how often the wallet signs, `deterministicSignature` returning null, `new MemoryStore()`, `stale_binding` on equal seq, `unknown_namespace` as 400 in a body, the mainnet wording, "adapted from" the tests, the CORS header list, `withdraw(message, signatures)`).
- An audience reviewer (a senior EVM and zero-knowledge engineer, Sonnet tier) returned 6 FIX, 7 SOFTEN, 5 HOLD; every FIX and SOFTEN was applied (soundness caveat on "cannot forge", the privacy sentence beside "unreviewed", the reservation contradiction between pages, the install command's relative path, "nothing to hide" on the ledger, Tempo scoping, signatures at registration, rollback detection is for a client that has seen a version, the own-origin node caveat on the guide, the nullifier wording, the sign-in chain id, sessions in the SDK page).
- `tsc` clean on the explorer and the SDK; `pnpm -C packages/explorer build` prerenders the three pages; `cargo fmt --check`, `cargo test -p bte-coordinator -p peal-links-node` green; both live examples ran against the Sepolia node and printed real records.

> Cross-tier verification reduces instance- and tier-level error correlation but not shared-lineage blind spots. Treat cross-tier survival as weaker evidence than grounding.

## Telemetry

- divergence: 0.93 (evidence 0.98, conclusion 0.85) | threshold 0.30 UNCALIBRATED
- grounding: n/a (no eval fixtures)
- models: draft=opus · verifiers=1x-opus grounding + 1x-sonnet audience (cross-tier; version axis unavailable)
- claims: route table, auth per route, limits, encodings, addresses, EIP-712 types, SDK method signatures: grounded (file:line re-opened); privacy and trust wording: cross-tier-survived after edits
- fleet: 4 explorers + 2 verifiers · token-multiple vs single-pass ≈ 5

## Open

- Publishing `peal-links` to npm would replace the path-dependency install. Not done: a publish is outward-facing and the user decides.
- `DepositIntent.amount` is a JSON number on the wire (`crates/peal-bonsai/src/deposit.rs`), the one deviation from the integer-strings rule. Documented, not changed, because the wasm prover emits the envelope and changing it touches three components.
- The directory's ERC-1271 path is unreachable while sessions are EOA-only. Documented as such.
