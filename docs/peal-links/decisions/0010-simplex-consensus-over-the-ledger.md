# 0010: Commonware simplex over the ledger state transition

Date: 2026-09-16. Status: accepted (Phase F, resolving the "ledger decentralisation" blocker).

## Decision

Peal Links validators run Commonware `simplex` (crates `commonware-consensus`, `-p2p`, `-runtime`, `-cryptography`, `-utils` pinned to `=2026.9.0`) in a new crate `crates/peal-links-consensus`, over the unchanged `peal_bonsai::ledger::Ledger` state transition. The API map that grounds every signature used is `research/commonware-simplex-api.md`.

1. **Payload.** A block is `{version, epoch, view, height, parent, txs}` where each transaction is one ledger envelope (register, operation or mint) tagged with its namespace. Blocks and transactions are JSON; a block's digest is SHA-256 of the exact bytes on the wire, and a transaction's identity is SHA-256 of its canonical encoding. Genesis is SHA-256 over the circuit id and the namespace set, so validators built for a different circuit or ledger set never share a parent.
2. **Voting is stateless.** A validator votes for a block when its round, parent and height match the consensus context, every envelope passes the checks that need no ledger state (namespace, circuit, signature, canonical encoding, the proof against the commitment the envelope claims to spend from), and every mint's deposit is confirmed by *this validator's own* chain view (`DepositOracle`). A chain that cannot be reached makes the validator abstain, never vote yes.
3. **Application is at finalization, in order, deterministic.** Every validator applies finalized blocks through the same `Ledger::register`, `apply_batch` and `mint` calls the single-node mode uses (proofs re-verified). Stateful failures (stale commitment, root outside the window, duplicate deposit id, unknown account) reject that transaction alone, identically everywhere, and the submitter is told which error. Empty blocks are applied too.
4. **Distribution and backfill.** Block bytes go to every validator on a dedicated channel when the engine asks the relay to broadcast; a validator missing bytes for a digest it must verify or apply asks all peers by digest and applies the ancestors it learns of in order. This replaces `marshal` for a local deployment and is the reason a validator that starts late catches up (test `a_validator_that_missed_blocks_catches_up_by_digest`).
5. **Proposers pre-confirm mints.** A mint enters a validator's mempool only after its own chain view confirmed the deposit, so a leader never proposes what its peers would refuse and a bad deposit id cannot stall the chain. The verifier-side check stays as the safety net; a verifier that refuses a block for a mint drops that mint from its own mempool.
6. **Identity and signing.** Validators are ed25519 keys (`commonware_cryptography::ed25519`), the scheme is the ed25519 certificate scheme with 2f+1 quorums (four validators tolerate one fault; three tolerate none), the elector is round-robin, and the epoch is static. Domain separation: the scheme namespace is derived from the genesis digest.
7. **Runtime.** A live validator runs on the Commonware tokio runtime on its own thread with `authenticated::discovery` p2p (every other validator listed as a bootstrapper); the node's axum runtime talks to it through a channel-backed `Handle`. Tests run the same actor and engine on the deterministic runtime over the simulated network.
8. **Settlement signatures travel over the same network.** The consensus crate carries opaque application requests between validators (`gather`) so a node can collect withdrawal signatures from peers that each verify the claim against their own replicated ledger (used by the node in decision 0005's committee, distributed form).

## Alternatives considered

- **`marshal` for ordering and backfill.** It is the upstream answer to gaps and height ordering, but at 2026.9.0 its application trait is ALPHA and the reference use (the `reshare` example) goes through `commonware_glue`, `broadcast::buffered` and a resolver on two extra channels. The digest backfill above is ~100 lines, deterministic, and tested; revisit when `marshal` stabilises.
- **State roots in the block.** A proposer cannot know the post-state of a block whose parent is notarized but not finalized without speculative execution; putting a pre-state root in the block would make verification stateful. Agreement is instead observed on the applied state root each validator reports after every block (`/links/v1/consensus`).
- **One consensus instance per namespace.** Rejected: one ordered log over all namespaces is simpler and keeps a single validator set.

## Consequences

- The ledger STF is untouched; the single-node mode remains (`consensus` absent from the node config).
- The product store (requests, inbox, deposit intents, withdrawals) stays per node; only the ledger is replicated. A client talks to one node for the product API and can read the ledger from any validator.
- The recorded blocker "ledger decentralisation" changes to: a local three-validator deployment exists and is exercised; validator key custody, dynamic validator sets, public-network deployment and `marshal` adoption remain open.
