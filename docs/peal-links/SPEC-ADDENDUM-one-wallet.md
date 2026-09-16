# Spec addendum: one wallet, private by default

Status: active. This addendum supersedes any earlier requirement that users manually create, copy, or manage a separate Bonsai wallet. Where it conflicts with `SPEC.md` section 8 (recipient onboarding, create a request, payer checkout, receive and claim) or section 11 (privacy and authorization), this file wins. Everything else in `SPEC.md` stands, including section 2 (fixed decisions), section 3 (what counts as real), and the ban on faking or substituting the trust model.

Bonsai stays mandatory. This changes the user experience, not the cryptographic foundation.

---

## 1. The principle

**The user's existing `0x` EVM wallet is their only visible payment identity.**

Users connect their current wallet, create a link or enter a recipient's address, and send or receive private payments. Peal handles Bonsai account provisioning, key management, proofs, receipt delivery, and balance synchronization behind the interface.

Use the connected `0x` address throughout the dashboard, account menu, payment requests, and recipient selection. Never require users to install another wallet, copy a Bonsai address, manage receipt openings, nullifiers, commitments, or proofs, switch between an "EVM account" and a "Bonsai account", or complete a separate product registration.

Internally, maintain the private account and state exactly as before. Never imply that an ordinary public ERC-20 balance has become private because the user connected a wallet. Where balances appear, show two: **Wallet balance** (public, on the funding chain) and **Private balance** (Bonsai, per asset domain).

---

## 2. Three design decisions that reconcile this with Bonsai

Read these before implementing. Each is recorded as a decision record in `docs/peal-links/decisions/` and referenced in `THREAT_MODEL.md`.

### 2a. Wallet authorization happens at the account level, not on the public ledger per operation

A wallet signature published with each Bonsai operation would label every operation with its `0x` address and destroy the privacy the construction keeps (amounts, counterparties, and direction hidden even though the acting account is visible). Verifying a secp256k1 signature inside the payment circuit is a major circuit change and is out of scope.

Therefore:

- At setup, the wallet signs one domain-bound EIP-712 **account authorization** binding: the `0x` address, the chain used for ownership verification, the Bonsai account and receiving encryption key, the ledger domain, a nonce, an expiry, and a version. This is what "the wallet authorized this private account" means.
- Each Bonsai operation is authorized by the Bonsai spending key inside the proof. Validators enforce that, as they already do. That satisfies "validators must enforce it".
- Per-payment wallet approval is a **local payment intent**: an EIP-712 signature over amount, recipient profile hash, request ID, ledger domain, account state version, nonce, and expiry. The client verifies it before proving and never transmits or publishes it. It gives the user a familiar wallet confirmation without leaking identity.
- The wallet signs publicly only for the EVM legs: token approval or permit, deposit transactions, and the withdrawal destination.
- Revocation: a newer authorization version supersedes older ones; a revocation record signed by the wallet marks an account authorization dead. Define what a revoked authorization means for receipts already in flight.

### 2b. Recovery uses the wallet where the wallet can do it, and one extra step where it can't

- Spending keys and receiving encryption keys are random, generated client-side with reviewed libraries. They are never derived directly from a signature.
- The **backup wrapping key** may be derived, with a proper KDF, from a wallet signature over a fixed, distinctive, domain-bound message that is never transmitted or published. This is only offered when the wallet is an EOA and the signature is verified deterministic (sign twice at setup, compare). Wallets that sign non-deterministically, contract wallets, and passkey wallets get a different path.
- Phishing exposure is real: any site can ask the user to sign the same message. Record this in `THREAT_MODEL.md`. Mitigate with a message that names Peal and the purpose in plain words, a warning in the recovery setup step, and an optional second factor (passkey PRF or user-held recovery phrase) that the user can turn on in one step. Never silently introduce custody to remove a step.
- Wallets that cannot derive: offer one concise setup step (passkey or recovery phrase) before funds can be received. Explain what it protects.
- Returning visits on the same device: local private state is encrypted at rest under a non-extractable WebCrypto key held in the browser, so no setup signature is requested again. Sessions have explicit expiry and revocation. A server login (EIP-4361 style) authenticates API access only and never confers spending authority.
- Encrypted backups are versioned snapshots plus deltas with authenticated ledger checkpoints and anti-rollback rules, as in `SPEC.md` section 9. Test on a fresh browser: reconnecting the wallet either restores usable private state or shows an honest recovery action. Never present an empty replacement account.

### 2c. The `0x`-to-Bonsai link is minimized and documented, not hidden

- The directory (section 4 below) is authenticated and rate-limited. Lookups require a logged-in session. Retained lookup metadata is minimal and documented.
- Deposits: check whether the gateway can deliver a deposit as an encrypted receipt from a gateway account, so the EVM chain never names the destination Bonsai account. If the construction supports this without circuit changes, use it. If not, the deposit names the account commitment and that leakage is documented as-is.
- Add rows to the observer matrix for the directory, the deposit gateway, and the backup service, stating exactly who learns the `0x`-to-Bonsai association. Interface abstraction does not create cryptographic unlinkability; say so in the privacy explanation on the landing page.

---

## 3. Automatic private account setup

On first use:

1. Connect the existing wallet.
2. Request one clearly worded, domain-bound setup authorization (2a).
3. Provision the internal Bonsai account and receiving encryption keys client-side.
4. Establish the authenticated association with the wallet: the signed receiving profile in section 4.
5. Persist private state securely and initialize recovery (2b).
6. Open the dashboard.

Do not request another setup signature on every visit. Separate spending authorization, encryption keys, and login sessions.

---

## 4. Directory: resolving a `0x` address to receiving details

- A **receiving profile** is a signed record: version, `0x` address, chain used for ownership verification, Bonsai receiving details, receiving encryption public key, ledger domain, issued-at, expiry, and the hash of the previous version. The wallet signs it (EIP-712). For contract wallets, verify with ERC-1271 on the named chain and record the chain and block; never assume the same address has identical ownership on every chain.
- The directory serves profiles. The sender verifies the signature locally before creating a payment and never trusts a directory-asserted key. The directory cannot substitute its own receiving key.
- Rotation: a new version signed by the wallet. The directory keeps an append-only log with hashes so withholding or rollback is detectable. Expiry bounds how long a stale profile can be served. Define what happens to requests created under an older version.
- Unregistered recipients: if a `0x` address has never activated private receiving, show a clear activation invitation and move no funds. Do not create an account on their behalf, do not report payment success, and do not improvise a funded invitation. Funded invitations require a separately designed recipient-bound escrow with refund rules and are out of scope for this build.

---

## 5. Send to a normal address

The send form accepts a supported `0x` address or a Peal payment link. Resolve the address through the directory (section 4), verify ownership, domain, version, and key rotation, then create the payment. Show the recipient's chosen name and shortened wallet address. The address is the verified part; the name is not an identity badge.

---

## 6. Payment-link experience

Creating a link requires only amount, supported asset and funding domain, and an optional description. The link manifest is signed by a profile key authorized under the account authorization (2a), so link creation does not need a wallet popup. The receiving details are authenticated within the request; users never select an internal Bonsai account.

Public checkout shows: recipient's chosen name and shortened wallet address, requested amount and description, supported payment route, total fees before authorization, and one primary next action. Possession of the link exposes its displayed details; never describe an unlisted link as confidential to a specific person.

---

## 7. One continuous checkout

If the payer already has sufficient private funds in the right asset domain, go straight to payment authorization. Otherwise compute the required top-up and guide funding and payment as one flow. Use batching or permits (EIP-2612 and the like) only where the token and chain actually support them and this is verified; never promise one signature when the route needs more.

Progress labels, showing only the applicable ones:

"Approve payment" → "Adding funds" → "Preparing payment" → "Payment sent."

"Adding funds" may take minutes on chains with slow finality policies; say so. Persist progress and intent IDs so a reload or lost response resumes safely without charging twice (`SPEC.md` section 8 rules apply). Explain, concisely and where it affects the choice, that deposits and withdrawals expose public addresses and amounts.

---

## 8. Receiving feels automatic

An unlocked recipient client retrieves encrypted receipts, verifies them, and claims them automatically within explicitly authorized session permissions. An offline recipient's receipts wait; their dashboard shows **Incoming** separately from **Available** until the claim completes. Never upload spending secrets to make automatic claiming easier. Never tell the sender a claim happened unless the protocol provides it or the recipient explicitly acknowledges it.

---

## 9. Boundaries

- Never log private witnesses, account openings, plaintext receipt contents, backup secrets, or payment intent signatures.
- Never publish the `0x`-to-Bonsai mapping unnecessarily. Document which services or validators learn it through authorization, deposits, or routing.
- Preserve Peal's existing visual design.

---

## 10. Acceptance criteria

Demonstrate two users, each interacting only through an existing EVM wallet:

1. Create and share a payment request.
2. Fund and complete a genuine Bonsai payment through the unified checkout.
3. Receive and claim with no manual Bonsai identifier anywhere in the interface.
4. Return after being offline and see Incoming become Available.
5. Recover on a fresh browser through the implemented mechanism (wallet-signature path for an EOA, plus the extra-step path for a wallet that cannot derive).
6. Resume an interrupted checkout without a duplicate payment.
7. Withdraw to the authorized EVM destination.
8. Attempt to pay an unregistered `0x` address and get the honest invitation flow with no funds moved.

Gate mapping: criteria 3 and 5 join Gate C; criteria 2, 6, and 8 join Gate E. Each is evidenced per `SPEC.md` section 4. Make implementation decisions autonomously, test the complete flow, and document any remaining dependency without replacing genuine private payments with a mock.
