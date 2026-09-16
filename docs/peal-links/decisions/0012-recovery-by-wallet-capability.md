# 0012: Recovery paths by wallet capability

Date: 2026-09-16. Status: accepted. Applies `SPEC-ADDENDUM-one-wallet.md` section 2b; replaces the passphrase-protected local account of SPEC.md section 8.

## Decision

1. **Keys are random, never derived from a signature.** The Bonsai spend key and the x25519 receiving key are generated in the wasm wallet from OS randomness (unchanged). A wallet signature only ever protects the *backup* of that state.
2. **At rest on a device**: the wasm storage key is wrapped under a non-extractable WebCrypto AES-GCM key kept in IndexedDB (`peal-links-device`). No passphrase, no setup signature on later visits. Clearing site data loses the device key; recovery then goes through 3 or 4.
3. **Derived-key path (EOA wallets that sign deterministically).** At setup the client checks the wallet is an externally owned account (`eth_getCode` on the ownership chain returns empty) and asks it to sign, twice, the fixed message

   ```
   Peal Links recovery key

   Signing this message lets Peal Links derive the key that protects the encrypted backup of your private payments account. Only sign it on the Peal Links site you opened yourself.

   Wallet: <0x address>
   Asset domain: <namespace label>
   Ledger: <namespace id hex>
   Purpose: peal-links/v1/backup-key
   ```

   If the two signatures are byte-identical the wallet signs deterministically (RFC 6979 or equivalent) and the backup key is `HKDF-SHA256(ikm = signature bytes, salt = "peal-links/v1/backup-key", info = address || namespace id)`, 32 bytes, derived with WebCrypto. The signature is used only in memory and is never transmitted, logged or stored. If the signatures differ, or the address holds code, this path is not offered.
4. **Recovery-code path (every other wallet: non-deterministic signers, contract wallets, passkey wallets; and available to EOA users as a second factor).** One setup step shows a generated recovery code (`PEAL-` plus 20 base32 characters, 100 bits, from OS randomness) that the user keeps. The backup is sealed under argon2id(code) with the existing backup parameters (64 MiB, 3 passes). The code is shown once, never stored by Peal, and the step says in plain words what it protects and what is lost without it.
5. **What a backup is**: the wallet state (spend key, receiving key, balance, claimed set, receipts, journal) sealed with XChaCha20-Poly1305 under the backup key, with the account's state version (`seq`) and the ledger namespace in authenticated metadata. It is uploaded to the node's backup store keyed by the session's 0x address and namespace (`PUT /links/v1/backups/{ns}`), and re-uploaded after every state change that a device makes. The node refuses an upload whose `seq` is lower than the stored one (anti-rollback) and stores at most the last 8 versions. A local file export stays available as a manual copy.
6. **Fresh browser.** Connect wallet, sign in, and the client finds the address's receiving profile in the directory. If it exists and no local state exists, the client offers exactly the recovery mechanism the profile records (`recovery: "wallet-signature"` or `"recovery-code"`), fetches the latest backup, opens it, restores, and reconciles against the ledger (the existing anti-rollback check). If no backup exists the page says so and offers the file import; it never creates an empty replacement account for an address that has a profile.
7. **Phishing.** Any site can ask a wallet to sign the recovery message. The message names Peal and the purpose in plain words; the setup step warns that this signature must only be given on Peal; the recovery-code second factor can be turned on in one step and then the backup is sealed under both (the derived key wrapped under the code). A stolen signature without the code cannot open the backup. Recorded in `THREAT_MODEL.md`.
8. **Sessions** have an explicit expiry (the node's `session_ttl_secs`) and sign-out deletes the token; the device key and the session are independent, and neither confers spending authority to the node.

## Why

- The addendum forbids deriving spending keys from signatures and forbids introducing custody to remove a step. Derived *backup* keys with the determinism check are the one place a wallet signature can stand in for a passphrase without a custodian.
- A wallet that cannot sign deterministically would make the backup unrecoverable one time in two; the code path is the honest alternative and doubles as the second factor.

## Consequences

- `LinksAccount.create/open/restore(passphrase)` become `LinksAccount.setup/unlock/recover` with a device key and a recovery mechanism; the wasm gains sealed backups under a raw 32-byte key (`export_backup_with_key`, `import_backup_with_key`).
- The Playwright wallet gains `eth_signTypedData_v4` and its `personal_sign` is deterministic (viem's local account), so the EOA path is exercised; the recovery-code path is exercised with a second context whose wallet reports code at its address (a contract-wallet stand-in through the test provider).
- Backup storage moves the observer-matrix row from "local file only" to "the node's backup service sees ciphertext, the 0x address, the namespace, sizes and times".
