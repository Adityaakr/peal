# Private Actions: architecture

How an encrypted agent intent becomes a settled transaction with a verifiable
receipt, and which parts of Peal already existed.

Read `private-actions-privacy-model.md` first for what is and is not guaranteed.

## What this reuses

Private Actions is a layer on the existing network, not a rewrite. Unchanged:

| component | role here |
|---|---|
| `crates/bte-crypto` | the seal. FO-transformed ElGamal over BLS12-381, 3-of-5 |
| `crates/bte-coordinator` | batching, freeze, share verification, reveal |
| `crates/bte-node` | operators: poll work, compute one 48-byte share, post it |
| `packages/sdk` (`bte-sdk`) | client-side sealing via wasm |
| `contracts/PealMempool.sol` | prior art: commit-to-ciphertext-hash, settle in committed order against a merkle root |

Two properties of the existing design do most of the work:

**Positions are a pure function of the ciphertext set.** At freeze, the
coordinator sorts ciphertext hashes ascending and assigns positions 0..B-1.
There is no executor discretion to abuse — the ordering is recomputable by
anyone from the set of ciphertexts. This is stronger than "the executor promised
not to reorder", and it is already tested (`spec/index.md` invariant 6).

**Nobody can read anything before the cue.** `GET /v0/reveals/:id` 404s for the
entire pending window, so pre-reveal ciphertext hashes are not even enumerable.

## What this adds

`packages/actions` (`peal-actions`), a new package. It depends on `viem` and
`bte-sdk`.

It is a separate package on purpose. `spec/index.md` calls the core "chainless":
sqlite plus content-addressed ciphertexts, no chain assumptions. Pulling `viem`
into `bte-sdk` — which compiles to wasm and is published to npm — would end
that. Chain-shaped concerns live here instead.

| module | what it is |
|---|---|
| `canonical.ts` | deterministic serialization. Everything signed or hashed goes through it |
| `hash.ts` | sha256 over WebCrypto, so agent and coordinator compute identical digests |
| `intent.ts` | the schema, and the privacy boundary as a type split |
| `state.ts` | the lifecycle graph, and the privacy property it enforces |
| `commitment.ts` | ordering root, inclusion proofs, executor commitment preimage |
| `sign.ts` | EIP-712 for intents and for execution authorizations |
| `receipt.ts` | receipt shape and independent verification |

## The privacy boundary, made structural

The schema is split in two, and the split is the security control:

```
IntentEnvelope   public from the moment of submission
SwapPayload      inside the ciphertext, unreadable until reveal
```

A field in the wrong half is a leak, so the envelope is kept almost uselessly
minimal — it carries nothing about *what* the action is. No action type, no
token pair, no amount, no recipient.

The one deliberate exception is `executionDomain` (the chain id), which the
coordinator needs in order to route a revealed intent to the right adapter. It
is bound into the signature so it cannot be swapped, and it is documented as a
metadata leak rather than hidden.

`test/intent.test.ts` asserts that no strategy field name appears in the
envelope, and that the signing preimage covers no payload field.

## Ordering: two roots, at two times

Peal already produces a merkle root at reveal, over `(position, payload)`. That
root is necessary but not sufficient here, because it only exists *after* the
payloads are readable — by which point an executor that wanted to reorder has
already had its chance.

So there are two roots:

```
orderingRoot   committed BEFORE any share exists.
               leaf = sha256(intentId || 0x00 || ciphertextHash)
               answers: was my intent in this batch, at this position,
                        before anyone could read it?

revealRoot     produced at reveal (existing, SDK anchor.ts).
               leaf = sha256(position_le_u32 || payload)
               answers: is the payload that executed the one that was
                        in that slot?
```

Together they close the loop: position fixed while blind, payload bound to
position once open. Either alone leaves a gap.

Both use the same tree construction as the coordinator's `merkle.rs` — sha256
leaves, `parent = sha256(left || right)`, odd node promoted — so one reviewer
checks one construction.

The `0x00` separator in the ordering leaf is load-bearing: without it,
concatenating a variable-length id onto a fixed-length hash lets two different
`(id, hash)` pairs produce identical bytes.

## The lifecycle, and the property it enforces

`state.ts` defines nineteen states and the legal edges between them. The point
is not bookkeeping; it is one safety property:

> No liquidity provider is contacted before inclusion and ordering are committed
> AND the batch has been revealed.

A comment saying "call the adapter after reveal" is not a guarantee — a refactor
deletes it. Instead `QUOTING` is only reachable through `ORDER_COMMITTED` and
`REVEALED`, and `test/state.test.ts` proves it by enumerating **every** simple
path in the graph and asserting both appear, in that order, on all of them. Add
an edge that lets an intent quote early and that test fails.

Two absences are deliberate:

- An intent cannot be `CANCELLED` between `BATCHED` and `THRESHOLD_REACHED`.
  Pulling a ciphertext out of a committed batch is exactly the reordering power
  the commitment exists to remove. The agent can still decline to authorize.
- Nothing skips `REVEALED`, even on failure paths, so a receipt's timeline is
  real.

## Signing: two signatures, not one

| when | what it binds |
|---|---|
| before submission | protocol version, intent id, encryption key id, ciphertext hash, nonce, expiry, execution domain |
| after reveal, having seen the quote | intent id, ciphertext hash, quote hash, call hash, minimum out, deadline, submission mode |

**Signing the intent is not consent to the execution.** An agent that signed an
intent has not pre-approved whatever quote comes back. This is why Peal never
holds an agent key and why `AUTHORIZATION_REQUIRED` is a real state that can
time out into `EXPIRED` rather than being executed on the agent's behalf.

`submissionMode` is inside the authorization so that an agent which authorized a
private submission cannot have it quietly broadcast through a public RPC.

## Receipt verification

`verifyReceipt` returns a report, not a boolean — an agent needs to know *which*
guarantee broke. Checks are independent, so one call surfaces every problem.

The check people forget is `commitmentPrecedesReveal`. Without it, an executor
could commit to an ordering *after* reading plaintext and every other check
would still pass.

Two checks report `false` when no verifier callback is supplied
(`executorCommitmentSignature`, `receiptSignature`), because how an executor
identity is validated is deployment policy. Reporting them as passing would be
the worst kind of green tick.

## Current status

Live and tested (93 tests in `packages/actions`):

- intent schema and privacy boundary
- canonical serialization
- lifecycle state machine with the enforced privacy property
- ordering commitment, inclusion proofs, position binding
- EIP-712 intent and authorization signing
- receipt construction and verification
- `/execution` in the explorer, including a working in-browser receipt verifier

Not built yet:

- coordinator `/v1` intent endpoints — intents cannot currently be submitted
- the `ExecutionAdapter` interface and the 0x Swap API v2 adapter
- the Across cross-chain adapter
- `TransactionSubmissionProvider` and private submission
- the example agent
- the executor service that ties reveal to quote to authorization

## Next

1. `ExecutionAdapter` interface plus the 0x v2 adapter, with quote validation
   against the signed floor. Verify the endpoint shape against
   `docs.0x.org` at implementation time rather than from memory — v1 is retired.
2. Coordinator `/v1` intent endpoints and persistence of the lifecycle.
3. The example agent and an end-to-end simulated swap.
