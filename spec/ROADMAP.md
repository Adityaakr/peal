# Roadmap (beyond v0)

Ordered roughly by leverage per unit of work.

1. **DKG ceremony.** Done for v1 committees (scheme v1, "DKG Is All You
   Need"; spec/index.md section 3b, decision 0015). The committee's secret is
   one scalar from Commonware's Feldman/Desmedt DKG over the coordinator's
   relay; no machine ever holds it. v0 committees keep the trusted dealer:
   its secret is the structured tau^1..tau^B, which no stock DKG produces, so
   v0 is not being retrofitted; the path for v0 users is item 3.
2. **Resharing via the same Commonware module.** `feldman_desmedt` supports
   resharing; wire it so a v1 committee can add, remove, or rotate operators
   without a fresh round from scratch. Note the parameter digest covers the
   DKG output, so a reshared committee is a new committee to sealers.
3. **Migrate the hosted committee to v1.** The peal.network coordinator still
   runs a v0 committee (`docker/start-railway.sh`); an operator runs a DKG
   round there, registers the v1 committee, and new conditions move to it.
   v0 keeps serving its existing committees.
4. **Oracle conditions.** Condition kinds beyond wall clock and block height:
   price feeds, governance outcomes, sports results, attested webhooks. The
   engine already isolates condition firing from freeze/reveal machinery.
5. **Staking and slashing.** Operators bond stake; provably invalid shares
   (they are publicly verifiable, so misbehavior is attributable) and
   liveness failures get slashed. Turns "stalls loudly" into "stalls
   expensively".
6. **Onchain verifier via EIP-2537.** BLS12-381 precompiles make the share
   verification pairing check and the Lagrange combination feasible in a
   contract. A reveal then carries an onchain proof, not just a merkle root
   from the coordinator.
7. **Permissionless registry.** Committees register onchain with their
   params digest; anyone can spin up a committee, and apps pick by digest.
8. **Blob/calldata ciphertext store.** The coordinator's sqlite store is
   already content-addressed; swap it for calldata or EIP-4844 blobs so
   ciphertext availability does not depend on one server.
9. **TEE packaging.** No longer needed for v1: there is no ceremony to
   protect, the DKG replaced it. Still a possible stopgap for a v0 committee
   that cannot migrate yet (run the dealer, and optionally operators, inside
   attested enclaves).
