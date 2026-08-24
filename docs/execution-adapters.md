# Execution adapters

Peal does not create liquidity, hold inventory, or route orders itself. It hands
a revealed intent to an adapter that talks to an external venue.

That separation is the point. A system that both promised fair ordering and made
markets would have every incentive Peal exists to remove.

## The interface

```
ExecutionAdapter
  supports(intent)                              cheap, no network
  validateIntent(intent)                        static checks, throws with a code
  getExecutionProposal(intent, lifecycle)        <- the gated one
  validateExecutionProposal(intent, proposal)   re-check against what was signed
  execute(intent, proposal, authorization)
  getStatus(executionId)
  buildReceiptData(executionId)
```

### The gate

`getExecutionProposal` takes an `IntentLifecycle`, and every implementation calls
`assertMayQuote` before touching the network. There is no overload that omits it.

This is deliberate. "Only quote after reveal" written as a comment is not a
guarantee — a refactor deletes it. Requiring the lifecycle in the signature means
an adapter is never *handed* an intent early, so it cannot leak one early even by
mistake. `test/adapters.test.ts` asserts that no `fetch` happens from any of the
seventeen pre-reveal states.

### Error codes, not messages

Adapters throw `AdapterError` with a stable `code`. Callers branch on the code;
messages are prose and free to change. Tests assert on codes for the same reason.

## 0x Swap API v2 — `zerox-swap-v2`

Same-chain EVM swaps. Endpoint shapes were verified against `docs.0x.org` at
implementation time rather than recalled:

- base `https://api.0x.org`
- `GET /swap/allowance-holder/quote`
- headers `0x-api-key`, `0x-version: v2`

**Swap API v1 is retired and is not used anywhere.** A test asserts the request
path never contains `/swap/v1/`.

### The quote is hostile input

It arrives over the network, after the agent has stopped looking, and it carries
calldata that will execute against the agent's own funds. Every field that could
move value is re-checked against what the agent actually signed.

Three rules that are easy to get wrong and expensive to get wrong:

**1. `minBuyAmount`, never `buyAmount`.** `buyAmount` is a mid-market expectation
the venue does not commit to. `minBuyAmount` is what survives slippage. Comparing
the agent's floor against `buyAmount` would pass quotes that settle underneath
it. There is a test for exactly this: a quote with a huge `buyAmount` hiding a
`minBuyAmount` of 1 is rejected.

**2. Approvals are doubly constrained.** The spender must be the
`allowanceTarget` the response itself named, *and* that address must appear in
operator-configured trusted config. Both, not either. The Settler contract is
never approved. Approvals are bounded to the exact trade amount — an infinite
approval outlives the intent that justified it.

The trusted list is operator-configured
(`PEAL_TRUSTED_ALLOWANCE_TARGETS_<chainId>`) rather than hardcoded in library
source. An allowlist baked into a package is one supply-chain compromise away
from redirecting every approval, and it rots silently when a venue redeploys.

**3. Fail safely.** `liquidityAvailable: false` → `NO_LIQUIDITY`.
`simulationIncomplete: true` → refuse; 0x could not simulate the trade, so its
own numbers are unverified, and executing anyway is how a swap reverts on-chain
with real gas spent. A balance issue where actual < expected → refuse.

### Retries

Bounded, and never past the deadline. `NETWORK` and `UPSTREAM` (429, 5xx) are
retried; a 4xx is not, because retrying a bad request just resends the same bad
request and spends the deadline. The deadline is re-checked on every attempt.

## Across — `across-swap-v1`

Cross-chain, **behind a feature flag, off by default** (`ACROSS_ENABLED=false`).
The interface, validation and tests are real; live credentials are not assumed.

Shapes verified against `docs.across.to`: base `https://app.across.to/api`,
`GET /swap/approval`, bearer auth, response carrying `approvalTxns`, `swapTx`,
`expectedOutputAmount`, `minOutputAmount`, `checks`, `fees`, and an expiry.

### Why it is a separate adapter

A cross-chain fill is not a swap that happens to take longer. Origin confirmation
says nothing about whether the destination was ever filled. Funds can sit in
flight, or come back as a refund on the origin chain.

So the settlement phases stay distinct all the way to the receipt:

```
ORIGIN_CONFIRMED   deposit landed on the origin chain
IN_FLIGHT          relayer has not filled yet
DESTINATION_FILLED funds actually arrived
REFUNDED           they came back instead
```

`buildReceiptData` only sets `destinationTransactionHash` once the phase is
`DESTINATION_FILLED`. A receipt claiming a destination hash for an in-flight
deposit would tell an agent it has ETH on Base when it has USDC on Arbitrum.

## CoW — placeholder only

An interface slot exists for a solver-based adapter. Nothing ships in V1.

One constraint if it is built: do not request a CoW quote before Peal ordering is
committed, if strict pre-order confidentiality is enabled. The gate above already
makes that structurally impossible, and it should stay that way.

## Submission is a separate layer

Adapters decide *what* to execute. `TransactionSubmissionProvider` decides *how
it is broadcast*. Neither `ZeroExAdapter.execute` nor `AcrossAdapter.execute`
broadcasts — both throw `NOT_IMPLEMENTED` and direct the caller to a submission
provider.

That is not an omission. An adapter that could broadcast could quietly downgrade
a private submission to a public one. It never holds the ability.

```
private     a relay that does not expose pending transactions
solver      handed to a solver network (none in V1)
public-rpc  ordinary eth_sendRawTransaction; visible in the public mempool
simulated   nothing is broadcast; for tests and the playground
```

`selectProvider` picks the first provider that serves the chain, preferring
private. Two outcomes worth distinguishing:

- Intent sets `privateSubmissionRequired` and no private route exists →
  **throws** `DegradedPrivacyError`. Executing anyway while recording
  `public-rpc` would be honest on the receipt but would still have broadcast
  something the agent said not to.
- No such requirement, only a public RPC → proceeds, returns `degraded: true`.
  The caller must show `DEGRADED_PRIVACY_WARNING`, the receipt records
  `public-rpc`, and **no sandwich protection may be claimed.**

The simulator reports `mode: "simulated"`, `privateRoute: false`, and never
invents a transaction hash. It settles at exactly the guaranteed minimum — the
pessimistic case, so a test that passes there passes for every real fill at or
above it.

## Adding an adapter

1. Implement `ExecutionAdapter`. Call `assertMayQuote` first in
   `getExecutionProposal`, before anything touches the network.
2. Treat the venue response as hostile. Re-derive; do not believe.
3. Compare the floor against the venue's *guaranteed* output, not its expected
   one.
4. Constrain approvals to configured spenders and to the exact trade amount.
5. Never broadcast from inside the adapter.
6. Add the gate test: no network call from any pre-reveal state.
