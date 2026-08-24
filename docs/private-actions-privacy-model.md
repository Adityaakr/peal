# Private Actions: the privacy model

What Peal hides, from whom, and for exactly how long.

This document exists to be pessimistic. Marketing copy for this category tends
toward "private trading", and that phrase is not defensible for what Peal
actually does. Read this before writing anything user-facing.

## The guarantee, in one sentence

> Intent contents remain encrypted until batch inclusion and ordering are
> committed.

That is the whole claim. Everything below either supports it or bounds it.

## What Peal does NOT guarantee

Say these out loud when someone asks:

- **Not permanent transaction privacy.** The settled transaction is public
  forever, like any other transaction.
- **Not complete MEV elimination.** Peal closes the window in which someone
  could reorder around a pending action. It does not make the eventual public
  transaction invisible, and it does not protect the interval between reveal and
  inclusion.
- **Not protection from the liquidity provider.** After reveal, the adapter asks
  0x (or Across) for a quote. That request is a normal HTTPS call and its
  contents are visible to that provider.
- **Not custody.** Peal never holds an agent's private key, and therefore cannot
  execute anything on an agent's behalf without a fresh signature.
- **Not a shielded pool.** If you need the settled transaction itself to be
  unlinkable, you need a ZK settlement system. That is out of scope.

## The lifecycle, with visibility at each stage

| # | stage | payload readable by | notes |
|---|---|---|---|
| 1 | Encrypted locally | the agent only | sealing happens in the agent's process; plaintext never leaves it |
| 2 | Submitted as ciphertext | the agent only | Peal receives a ciphertext and an envelope |
| 3 | Included in batch | the agent only | position assigned, still unreadable |
| 4 | Order locked | the agent only | executor signs the ordering root; **it cannot see what it just ordered** |
| 5 | Threshold reached | the agent only | t of n operators have posted shares |
| 6 | Revealed to executor | executor, and anyone holding t shares | plaintext now exists |
| 7 | Submitted for execution | + the liquidity API, + the submission path | quote request leaves the building |
| 8 | Publicly settled | everyone, permanently | on-chain forever |

Stages 1–5 are the product. Stages 6–8 are the honest cost of settling on a
public chain.

## What leaks even before reveal

The encrypted payload is not the only thing an observer sees. The public
envelope is visible from submission, and it carries:

- `intentId`, `nonce`, `createdAt`, `expiresAt` — timing metadata
- `ciphertextHash` — an opaque identifier
- `encryptionKeyId` — which committee
- `pseudonymousSigner` — **the agent's address**
- `executionDomain` — **which chain the action will execute on**

So a pre-reveal observer learns: *this address is about to do something on this
chain, within this time window*. They do not learn the action type, the token
pair, the amount, the direction, the recipient, or the slippage tolerance.

Two of these deserve emphasis because they are real:

**The signer address is public.** Intents are pseudonymous, not anonymous. An
agent that reuses one address builds a linkable history of *when* it acts, even
though *what* it does stays sealed until reveal. Agents that care should rotate
addresses.

**Batch size and timing leak.** An observer counting ciphertexts in a batch
learns how many actions are pending. In a batch of 64 with 3 real intents, the
padding hides which slots are real, but not that the batch exists.

## The reveal-to-inclusion window

This is the sharpest remaining edge, and it is not closed.

Between stage 6 and stage 8 the plaintext exists and the transaction is not yet
mined. Anyone who learns the action during that window — the executor, the
liquidity provider, or an observer of a public mempool — can act on it.

Peal narrows the window by construction:

- No liquidity provider is contacted before ordering is committed. This is
  enforced by the lifecycle state machine, where `QUOTING` is unreachable
  without passing `ORDER_COMMITTED` and `REVEALED`, and proved by exhaustive
  path search in `packages/actions/test/state.test.ts`.
- The quote is requested immediately after reveal, validated, authorized, and
  submitted, rather than parked.
- Where a verified private submission provider exists for the chain, the
  transaction is submitted through it and never touches a public mempool.

**If only a standard public RPC is configured, the window is wide open and Peal
must say so.** In that configuration the UI shows a degraded-privacy warning,
the receipt records `submissionMode: "public-rpc"`, and no sandwich protection
may be claimed. Never advertise private execution for a transaction that was
broadcast publicly.

## Who can decrypt, and when

Peal uses batched threshold encryption with a 3-of-5 committee (`n=5`, `t=3`).

- Fewer than 3 operators: cannot decrypt. Not "should not" — cannot.
- Any 3 operators colluding **before** the cue: can decrypt the whole batch
  early. This is the core trust assumption and it is not removable at t=3.
- Shares are publicly verifiable, so an operator that posts a bad share is
  attributable. There is currently no staking or slashing, so attribution has no
  economic consequence yet.

### Operator withholding

If fewer than 3 operators post shares, the batch never opens. The coordinator
marks the condition `stalled` after `REVEAL_TIMEOUT_SECS` and exposes it. The
intent then expires unexecuted. It fails loudly; it does not hang silently.

### Trusted dealer — the biggest caveat

**Peal v0 has no DKG.** A single trusted-dealer ceremony generates `tau`, Shamir
-deals shares of each power, publishes the public parameters, and destroys
`tau`. Anyone who held `tau` during that ceremony, or who captured it, can
decrypt every batch under those parameters — alone, at any time, forever.

Do not describe Peal as trustless while this is true. Replacing the dealer with
a DKG is item 1 on `spec/ROADMAP.md`.

## What the receipt reveals

A receipt is designed to be shown to third parties as proof of fair execution,
so it deliberately does not republish the payload. It carries
`revealedPayloadHash`, not the payload.

It does carry the settled amounts and the signed minimum. Those are already in
the settled transaction's own calldata, so echoing them costs nothing and the
floor check needs them. What stays out is everything the agent sealed that
settlement does *not* publish: the fee ceiling it was willing to pay, which
adapters it prefers or refuses, whether it would accept a partial fill, and any
agent metadata. Those describe how the agent trades, not what one trade did.

## Logging

Never logged, at any level, in any environment:

- plaintext intents, or any field of one before reveal
- token pair, amount, or recipient before reveal
- private keys, API keys, symmetric keys, operator secret shares
- full authorization signatures in routine logs

Safe to log: intent id, batch id, state, ciphertext hash, timing metrics,
adapter name, error code, and the transaction hash once submitted.

## Summary of trust assumptions

| assumption | consequence if wrong |
|---|---|
| Fewer than 3 of 5 operators collude | early decryption of an entire batch |
| The dealer destroyed `tau` | permanent decryption of every batch |
| The executor commits ordering before requesting shares | reordering becomes possible |
| The liquidity provider does not act on quote requests | front-running in the reveal-to-inclusion window |
| The private submission provider does not leak | same |
| The agent's own key is not compromised | full impersonation |

Peal removes the executor's ability to reorder around a *pending* action, and
proves it after the fact with a receipt. It does not remove the other rows.
