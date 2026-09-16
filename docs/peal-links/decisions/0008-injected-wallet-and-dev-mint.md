# 0008: Injected browser wallets alongside Privy; a labelled dev-mint fixture until Phase D

Date: 2026-09-16. Status: accepted.

## Decision
- The Peal Links pages offer two ways to connect an EVM wallet: the existing Privy sign-in (embedded wallet, email) and **"Use browser wallet"**, an injected EIP-1193 provider (`auth.tsx::connectInjected`). Both publish into the same session state; Privy's bridge only clears a Privy-sourced connection.
- Browser end-to-end tests inject a minimal EIP-1193 provider backed by a viem local account (anvil's public test keys) through Playwright's `addInitScript`. This is test harness outside the app; the app code path is the same one a MetaMask user takes.
- Until real deposits exist (Phase D), the node can mount `POST /links/v1/dev/mint` behind `PEAL_LINKS_DEV_MINT=1` (config `dev_mint`), which credits a registered deposit intent without a chain event. Everything else in that path is real: the R_dep proof, the intent, the mint on the ledger, the claim proof. It is labelled in the status document, the node log and the UI, and it refuses to start with a mainnet namespace.

## Why
- Privy cannot be driven headlessly (email login), and a payer who already holds funds in a browser wallet should not need an embedded one. Supporting injected providers is a product feature that also makes the flow testable without faking a signature.
- The chain gateway and watcher are Phase D work; the private ledger, proving, inbox and product flows can be verified end to end now with only the on-chain leg stood in for, and the fixture is isolated behind a default-off flag with a blocker record.

## Consequences
- ERC-1271 contract wallets are refused at sign-in with an explicit error (their validity is chain-state dependent and this node does not verify it).
- The dev-mint endpoint is removed from the default configuration when Phase D closes; the blocker record in BUILD_STATUS.md tracks it.
