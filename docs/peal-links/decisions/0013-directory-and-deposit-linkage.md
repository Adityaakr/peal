# 0013: The directory, and what a deposit reveals

Date: 2026-09-16. Status: accepted. Applies `SPEC-ADDENDUM-one-wallet.md` sections 2c and 4, after checking what the pinned construction supports.

## What was checked

The deposit relation Peal added to Bonsai (decision 0004, `crates/peal-bonsai/src/deposit.rs`) already keeps the destination account off the chain. The depositor proves, before the transaction, that the receipt commitment `rho = Com_rec(v, MINT, A, 1; r'')` opens to the observed amount `v`; the chain, the gateway and the watcher see only `(v, rho)`. `rho` is a hiding Poseidon commitment whose account `A` and randomness are the R_dep witness; nothing on chain names `A`. The ledger's public log then shows a mint at some position with `rho` as the leaf, and the claim of that receipt is an ordinary R_op receive that reveals the acting account but not which receipt it claims (membership is proven against the tree root). So the pinned construction does not need a "gateway account that sends an encrypted receipt": the encrypted-receipt property it would buy (the chain never naming the destination account) already holds, and such a gateway account would need a spending key held by an operator, which is custody the addendum forbids.

## Decision

1. **Deposits stay as built.** The chain records the depositor's 0x address, the amount, and `rho`. What leaks is stated, not hidden: a public observer links `0x depositor -> rho -> the ledger's mint position`; nobody but the depositor can link that position to the account that later claims it, except by amount-and-timing correlation, which the observer matrix already lists for every operation.
2. **The directory** (`crates/peal-links-node`, table `directory`) stores signed receiving profiles (decision 0011) append-only: `(namespace, address, version, profile JSON, hash, prev_hash, chain_id, verified_at_block, created_at)`. Publishing requires a session for the same address (`PUT /links/v1/directory`); the node verifies the EIP-712 signature (an EOA by recovery; a contract wallet through ERC-1271 `isValidSignature` on the namespace's chain, recording the chain id and block), checks `prev` against its log, and refuses a lower version. Reading (`GET /links/v1/directory/{ns}/{address}`) requires a session and is rate-limited per session (60 lookups per minute) and per IP. The response carries the profile, its hash, and the hash chain of earlier versions, so a client that saw a later version can detect a rollback. Lookups are not logged beyond the rate counters; the node retains the profiles themselves and the session-to-address mapping it already had.
3. **The sender never trusts the directory.** The client verifies the profile's signature against the 0x address it typed (viem `verifyTypedData`, EOA or ERC-1271), checks the ledger domain, the expiry, and that the manifest of a payment link was signed by the profile's `profileKey`. A directory that substitutes a receiving key produces a signature that does not recover to the address and is refused.
4. **Rotation and requests.** A new profile version rotates the receiving key or the display name; requests created under an older version keep their own signed manifest (the manifest carries the key at creation), so an in-flight request stays payable to the account that created it until its expiry or archive. A request under a revoked profile is archived by the node when the revocation is published.
5. **Unregistered recipients.** An address with no profile gets the invitation state: the sender sees "This address has not activated private receiving on Peal Links yet", may copy an invitation link, and no funds move. No account is created for anyone by anyone else; funded invitations are out of scope (addendum section 4).
6. **Backups** (decision 0012) live in the same node under the session's address; the node stores ciphertext, sizes and times only.

## Who learns the 0x-to-Bonsai association

| Party | Learns | Through |
|---|---|---|
| The node (directory, request API, backup store) | `0x -> Bonsai account id, receiving key, display name` for every registered user | the signed profile it stores; request creation (session address plus manifest); backup uploads (address only, ciphertext) |
| A signed-in user who looks an address up | the profile of the addresses they query | directory lookups (rate-limited, session-bound) |
| Validators / the public ledger | nothing new: acting account ids per operation, as before | no wallet signature or address is ever published with an operation |
| The chain and its observers | depositor and withdrawal-recipient addresses with amounts, and the deposit's `rho` | EVM legs; the account inside `rho` is not derivable |
| Watcher and settlement signers | as before (receipt commitment per deposit, burn opening per withdrawal), plus, on the withdrawing side, the recipient address the wallet chose | deposit events and withdrawal claims |

Interface abstraction does not create cryptographic unlinkability; the landing page's privacy explanation says so in one sentence.
