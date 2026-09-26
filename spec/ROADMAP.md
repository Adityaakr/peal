# Roadmap (beyond v0)

Ordered roughly by leverage per unit of work.

1. **DKG ceremony.** Replace the trusted dealer with a distributed key
   generation so no single machine ever holds tau. The blog's thresholdize
   construction shares each power tau^i independently, which is exactly the
   shape a DKG needs to produce. This deletes the biggest trust caveat.
2. **Resharing / operator rotation.** Proactive resharing of the tau^i shares
   so operators can be added, removed, or rotated without a new ceremony and
   without changing the public encryption key.
3. **Oracle conditions.** Condition kinds beyond wall clock and block height:
   price feeds, governance outcomes, sports results, attested webhooks. The
   engine already isolates condition firing from freeze/reveal machinery.
4. **Staking and slashing.** Operators bond stake; provably invalid shares
   (they are publicly verifiable, so misbehavior is attributable) and
   liveness failures get slashed. Turns "stalls loudly" into "stalls
   expensively".
5. **Onchain verifier via EIP-2537.** BLS12-381 precompiles make the share
   verification pairing check and the Lagrange combination feasible in a
   contract. A reveal then carries an onchain proof, not just a merkle root
   from the coordinator.
6. **Permissionless registry.** Committees register onchain with their
   params digest; anyone can spin up a committee, and apps pick by digest.
7. **Blob/calldata ciphertext store.** The coordinator's sqlite store is
   already content-addressed; swap it for calldata or EIP-4844 blobs so
   ciphertext availability does not depend on one server.
8. **TEE packaging.** Run the ceremony (and optionally operators) inside
   attested enclaves as a stopgap trust improvement before DKG lands.
