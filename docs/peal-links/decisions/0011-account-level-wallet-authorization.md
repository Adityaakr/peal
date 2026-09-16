# 0011: Wallet authorization at the account level, local payment intents

Date: 2026-09-16. Status: accepted. Applies `SPEC-ADDENDUM-one-wallet.md` section 2a; supersedes SPEC.md section 8's separate account creation and section 11 where they differ.

## Decision

1. **One setup signature, two uses.** At first use the connected wallet signs one EIP-712 message, `PealLinksAccount`, that binds: `version`, `address` (the 0x wallet), `chainId` (the chain used for ownership verification, the namespace's chain), `namespace` (ledger domain, bytes32), `account` (the Bonsai account id, bytes32), `encKey` (x25519 receiving key, bytes32), `profileKey` (the ed25519 key that signs request manifests and key bindings, bytes32; it is the account's spend-key public key, so "authorized under the account authorization" and "the key the account derives from" are the same key), `displayName`, `nonce`, `issuedAt`, `expiry`, `prev` (hash of the previous version or zero) and `revoked`. The EIP-712 domain is `{ name: "Peal Links", version: "1", chainId }` with no verifying contract. The same signed record is the **account authorization** kept locally with the private state, and the **receiving profile** published to the directory (decision 0013). Nothing on the public ledger carries it.
2. **Ledger operations stay authorized by the Bonsai spending key inside the proof.** Validators enforce that as before (envelope signature by the account key, proof over the account's commitment). No secp256k1 verification is added to any circuit and no wallet signature is published with an operation.
3. **Per-payment approval is a local payment intent.** Before proving a send, the client asks the wallet for one EIP-712 signature over `PealLinksPaymentIntent { amount, recipientProfileHash, requestId, namespace, accountStateVersion, nonce, expiry }`. The client verifies that the recovered address is the connected wallet (viem `verifyTypedData`, which also handles contract wallets through ERC-1271 / ERC-6492 on the namespace chain), then proves. The signature is never transmitted, logged or stored beyond the checkout's in-memory state. It is a user-confirmation step, not a protocol input: a payment proven without it is still a valid ledger operation, which is why the wallet signature adds no trust and removes no privacy.
4. **The wallet signs publicly only for EVM legs**: token approval, the deposit transaction, and the withdrawal destination (the certificate names the recipient the wallet chose).
5. **Sessions.** The EIP-4361 sign-in stays as it is: it authenticates product API access (requests, directory lookups, backups) and confers no spending authority. Local private state is encrypted at rest under a non-extractable WebCrypto AES-GCM key stored in IndexedDB, so returning visits need no setup signature.
6. **Revocation and rotation.** A newer `version` of the profile signed by the same wallet supersedes older ones; the directory keeps the append-only log. A version with `revoked: true` marks the authorization dead: the directory stops serving receiving details for the address (senders get the "not receiving" state), requests created under it are archived by the node, and receipts already delivered stay claimable by the account (the ledger does not know about profiles; revocation is a product-level fact). Funds are moved out by withdrawal, never deleted.

## Why

- Publishing a wallet signature per operation would label every ledger operation with a 0x address and turn Bonsai's account-level privacy (paper leakage L_ind: the acting account is visible, amounts and counterparties are not) into full linkability.
- In-circuit secp256k1 verification is a circuit change to the pinned construction, out of scope by the addendum.
- A single setup signature keeps first use to the minimum popups that still bind the wallet to the private account: sign-in (session), the account record, and the recovery step of decision 0012.

## Consequences

- `RequestManifest` gains `receiver_address` (manifest version 2) so a checkout can show the recipient's shortened wallet address and verify, through the directory, that the manifest's signing key is the one the wallet authorized.
- The dashboard, account menu, requests and recipient selection show the 0x address only; the Bonsai account id and encryption key are never rendered.
- `THREAT_MODEL.md` records that the node learns the 0x-to-Bonsai association from the profile it stores (directory) and from request creation (session address + manifest); validators learn nothing new.
