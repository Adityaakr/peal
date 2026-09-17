// A private account on one namespace, behind the connected wallet: the
// wallet state, its encrypted local storage, and every flow the product
// needs (set up, publish the receiving profile, fund, pay a request or an
// address, sync the inbox, claim, withdraw, back up, recover).
//
// One-wallet rules (decisions 0011 to 0013):
// - the 0x wallet signs one receiving profile at setup (the account
//   authorization published to the directory) and, per payment, a local
//   payment intent that is verified here and never transmitted;
// - private state is sealed under a device key (WebCrypto, non-extractable)
//   so a returning visit needs neither passphrase nor signature;
// - the backup key is derived from a deterministic wallet signature or
//   protected by a recovery code; backups are uploaded to the node as
//   ciphertext after every state change.
//
// Ordering rules that make the flows crash-safe, all enforced here:
// - a prepared operation is saved (encrypted) BEFORE it is submitted, so an
//   acknowledgement lost in flight is resolved by `reconcile`, never by
//   proving and paying twice;
// - a deposit intent is saved before the caller is handed the receipt to put
//   on chain;
// - an accepted send whose receipt envelope could not be delivered goes to a
//   local outbox and is retried on the next sync; the send is never reported
//   as failed.

import type { Hex, PublicClient } from 'viem';
import { LinksApiError, NodeClient, type PaymentRequest, type ReceiptPath, type WithdrawalCertificate } from './client.js';
import { deviceKey, MemoryDeviceKeys, openWithDevice, sealWithDevice, type DeviceKeys } from './device.js';
import type { AsyncProver, Delivery, WalletView } from './prover.js';
import { normalizeRecoveryCode } from './recovery.js';
import {
  profileHash,
  profileTypedData,
  randomHex32,
  verifyPaymentIntent,
  verifyProfile,
  type PaymentIntent,
  type Profile,
  type RecoveryMechanism,
  type UnsignedProfile,
  type WalletSigner,
} from './typed.js';

export interface WalletStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryStore implements WalletStore {
  private m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
  }
  async delete(k: string) {
    this.m.delete(k);
  }
}

interface OutboxEntry {
  account: string;
  envelope: unknown;
  request_id: string | null;
}

export interface PayResult {
  position: number;
  delivered: boolean;
}

export interface AccountOptions {
  prover: AsyncProver;
  client: NodeClient;
  namespace: string;
  store: WalletStore;
  /** Where the device key lives. Defaults to memory (tests, scripts). */
  deviceKeys?: DeviceKeys;
  /** Verifies contract-wallet signatures (ERC-1271) when present. */
  publicClient?: PublicClient;
}

/** The recovery material chosen at setup (decision 0012). */
export type RecoveryPlan =
  | { mechanism: 'wallet-signature'; backupKey: string }
  | { mechanism: 'recovery-code'; code: string };

/** What a payment goes to: a signed request, or an address resolved
 * through the directory. */
export type PaymentTarget =
  | { request: PaymentRequest }
  | { profile: Profile; profileHash: string; amount: string; reference?: string | null };

/** The wallet's confirmation of a payment, verified locally. */
export interface PaymentApproval {
  intent: PaymentIntent;
  signature: Hex;
}

export const PROFILE_VALIDITY_SECS = 365 * 24 * 3600;

const key = (ns: string, what: string) => `peal-links:${ns}:${what}`;

/** Everything an account leaves in a store for one namespace. */
const ACCOUNT_KEYS = ['wallet', 'device-sealed-key', 'backup-key', 'backup-wrapped', 'profile', 'inbox-cursor', 'outbox', 'labels'] as const;

/** A view of `store` that belongs to one wallet address, so several wallets
 * used from the same browser each keep their own private account instead
 * of colliding on the namespace's keys. The address is the only visible
 * identity (decision 0011), so it is the natural partition. */
export function walletScopedStore(store: WalletStore, owner: string): WalletStore {
  const prefix = `${owner.toLowerCase()}|`;
  return {
    get: (k) => store.get(prefix + k),
    set: (k, v) => store.set(prefix + k, v),
    delete: (k) => store.delete(prefix + k),
  };
}

export class LinksAccount {
  private wallet: string;
  private readonly prover: AsyncProver;
  private readonly client: NodeClient;
  readonly namespace: string;
  private readonly store: WalletStore;
  private readonly storageKey: string;
  private readonly publicClient?: PublicClient;
  /** Hex key that seals backups, or null before recovery is set up. */
  private backupKey: string | null;
  /** The locked wallet blob this instance last wrote or read, so another
   * tab's newer save can be told apart from our own. */
  private lastSaved: string | null = null;

  private constructor(opts: AccountOptions, wallet: string, storageKey: string, backupKey: string | null) {
    this.prover = opts.prover;
    this.client = opts.client;
    this.namespace = opts.namespace;
    this.store = opts.store;
    this.wallet = wallet;
    this.storageKey = storageKey;
    this.backupKey = backupKey;
    this.publicClient = opts.publicClient;
  }

  /** Whether an encrypted wallet exists in the store for this namespace. */
  static async exists(store: WalletStore, namespace: string): Promise<boolean> {
    return (await store.get(key(namespace, 'wallet'))) !== null;
  }

  /** Accounts saved before stores were partitioned per wallet sit under the
   * bare namespace keys of `opts.store`. When that account belongs to
   * `owner`, move it into the owner's scoped view and return `moved`;
   * when it belongs to another wallet leave it for that wallet (`other`);
   * `none` when there is nothing to adopt. Needs the proving worker, since
   * reading the owner means unlocking the account once. */
  static async adoptUnscoped(opts: AccountOptions, owner: string): Promise<'moved' | 'other' | 'none'> {
    if (!(await LinksAccount.exists(opts.store, opts.namespace))) return 'none';
    const legacy = await LinksAccount.unlock(opts);
    const address = await legacy.walletAddress();
    if (!address || address.toLowerCase() !== owner.toLowerCase()) return 'other';
    const scoped = walletScopedStore(opts.store, owner);
    for (const what of ACCOUNT_KEYS) {
      const k = key(opts.namespace, what);
      const v = await opts.store.get(k);
      if (v !== null) await scoped.set(k, v);
    }
    for (const what of ACCOUNT_KEYS) await opts.store.delete(key(opts.namespace, what));
    return 'moved';
  }

  /** Remove every stored key of the account for `namespace` from `store`.
   * Used when the ledger the account was registered on no longer exists;
   * the caller decides whether to export first. */
  static async forget(store: WalletStore, namespace: string): Promise<void> {
    for (const what of ACCOUNT_KEYS) await store.delete(key(namespace, what));
  }

  // ---- lifecycle -----------------------------------------------------------

  /** First use: provision the private account, register it, have the wallet
   * sign the receiving profile, publish it, seal everything under the
   * device key and upload the first backup. The wallet signs once here
   * (the profile); the recovery plan was prepared by the caller. */
  static async setup(
    opts: AccountOptions,
    circuitId: string,
    signer: WalletSigner,
    displayName: string,
    recovery: RecoveryPlan,
  ): Promise<LinksAccount> {
    if (await LinksAccount.exists(opts.store, opts.namespace)) throw new Error('an account already exists here; unlock or recover it');
    const wallet = await opts.prover.createWallet(opts.namespace, circuitId);
    const storageKey = await opts.prover.newStorageKey();
    const dk = await deviceKey(opts.deviceKeys ?? new MemoryDeviceKeys());
    await opts.store.set(key(opts.namespace, 'device-sealed-key'), await sealWithDevice(dk, storageKey));
    const backupKey = recovery.mechanism === 'wallet-signature' ? recovery.backupKey : await opts.prover.newStorageKey();
    const acct = new LinksAccount(opts, wallet, storageKey, backupKey);
    await acct.save();
    await acct.register();
    await acct.publishProfile(signer, displayName, recovery.mechanism);
    await opts.store.set(key(opts.namespace, 'backup-key'), await sealWithDevice(dk, backupKey));
    if (recovery.mechanism === 'recovery-code') {
      const code = normalizeRecoveryCode(recovery.code);
      if (!code) throw new Error('malformed recovery code');
      await opts.store.set(key(opts.namespace, 'backup-wrapped'), await opts.prover.wrapKey(backupKey, code));
    }
    // Recovery is part of setup: no account is handed over without its
    // first backup stored.
    if (!(await acct.backupNow())) throw new Error('the first backup could not be stored; setup is not complete');
    return acct;
  }

  /** A returning visit on the same device: no passphrase, no signature. */
  static async unlock(opts: AccountOptions): Promise<LinksAccount> {
    const sealedKey = await opts.store.get(key(opts.namespace, 'device-sealed-key'));
    const locked = await opts.store.get(key(opts.namespace, 'wallet'));
    if (!sealedKey || !locked) throw new Error('no account stored here');
    const dk = await deviceKey(opts.deviceKeys ?? new MemoryDeviceKeys());
    const storageKey = await openWithDevice(dk, sealedKey);
    const wallet = await opts.prover.unlockWallet(locked, storageKey);
    const sealedBackup = await opts.store.get(key(opts.namespace, 'backup-key'));
    const backupKey = sealedBackup ? await openWithDevice(dk, sealedBackup) : null;
    const acct = new LinksAccount(opts, wallet, storageKey, backupKey);
    acct.lastSaved = locked;
    return acct;
  }

  /** A fresh browser: fetch the latest backup the node holds for the
   * signed-in wallet and open it with the derived key or the recovery
   * code, then reconcile against the ledger (anti-rollback). Never creates
   * an empty replacement account. */
  static async recover(opts: AccountOptions, secret: RecoveryPlan): Promise<LinksAccount> {
    const stored = await opts.client.backup(opts.namespace);
    if (!stored) throw new Error('no backup is stored for this wallet');
    if (stored.mechanism !== secret.mechanism) throw new Error(`this backup needs the ${stored.mechanism} path`);
    const blob = JSON.parse(stored.blob) as { sealed: string; wrapped?: string };
    let backupKey: string;
    if (secret.mechanism === 'wallet-signature') {
      backupKey = secret.backupKey;
    } else {
      const code = normalizeRecoveryCode(secret.code);
      if (!code || !blob.wrapped) throw new Error('malformed recovery code');
      backupKey = await opts.prover.unwrapKey(blob.wrapped, code);
    }
    const wallet = await opts.prover.unlockWallet(blob.sealed, backupKey);
    const storageKey = await opts.prover.newStorageKey();
    const dk = await deviceKey(opts.deviceKeys ?? new MemoryDeviceKeys());
    await opts.store.set(key(opts.namespace, 'device-sealed-key'), await sealWithDevice(dk, storageKey));
    await opts.store.set(key(opts.namespace, 'backup-key'), await sealWithDevice(dk, backupKey));
    if (blob.wrapped) await opts.store.set(key(opts.namespace, 'backup-wrapped'), blob.wrapped);
    const acct = new LinksAccount(opts, wallet, storageKey, backupKey);
    await acct.save();
    // Anti-rollback: a restored wallet is checked against the ledger before
    // it is used, so a stale backup cannot double-spend into a conflict
    // unnoticed.
    await acct.reconcile();
    await acct.register();
    await acct.adoptProfile();
    return acct;
  }

  /** Copy the signed-in wallet's directory profile to this device, when it
   * names this account (a recovered device has the state but not the
   * profile). */
  private async adoptProfile(): Promise<void> {
    try {
      const me = await this.client.me();
      const entry = await this.client.profile(this.namespace, me.address);
      const v = await this.view();
      if (entry && entry.profile.account === v.account && !entry.profile.revoked) {
        await this.store.set(key(this.namespace, 'profile'), JSON.stringify(entry.profile));
      }
    } catch {
      /* not signed in: the caller publishes or adopts a profile later */
    }
  }

  /** Restore from an exported file protected by a recovery code. */
  static async restoreFile(opts: AccountOptions, backupJson: string, code: string): Promise<LinksAccount> {
    const wallet = await opts.prover.importBackup(backupJson, normalizeRecoveryCode(code) ?? code);
    const storageKey = await opts.prover.newStorageKey();
    const dk = await deviceKey(opts.deviceKeys ?? new MemoryDeviceKeys());
    await opts.store.set(key(opts.namespace, 'device-sealed-key'), await sealWithDevice(dk, storageKey));
    const acct = new LinksAccount(opts, wallet, storageKey, null);
    await acct.save();
    await acct.reconcile();
    await acct.adoptProfile();
    return acct;
  }

  private async save(): Promise<void> {
    const locked = await this.prover.lockWallet(this.wallet, this.storageKey);
    await this.store.set(key(this.namespace, 'wallet'), locked);
    this.lastSaved = locked;
  }

  // ---- several tabs, one account ------------------------------------------------
  //
  // Tabs of the same browser share the store but each holds its own copy of
  // the wallet. An operation therefore takes a lock named for the account
  // and reloads the copy another tab may have saved before it runs, so two
  // tabs never prove from the same state and a tab left open does not
  // overwrite newer state with old.

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const name = `peal-links:${this.namespace}:${(await this.view()).account}`;
    const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManager }).locks : undefined;
    if (!locks) {
      await this.refreshFromStore();
      return fn();
    }
    return locks.request(name, async () => {
      await this.refreshFromStore();
      return fn();
    });
  }

  /** Reload the wallet from the store when another tab saved a newer copy. */
  async refreshFromStore(): Promise<boolean> {
    const locked = await this.store.get(key(this.namespace, 'wallet'));
    if (!locked || locked === this.lastSaved) return false;
    this.wallet = await this.prover.unlockWallet(locked, this.storageKey);
    this.lastSaved = locked;
    return true;
  }

  /** Replace the wallet with the node's backup when that one is newer. The
   * backups carry a monotonic sequence, so a stale copy can never win. */
  async refreshFromBackup(): Promise<boolean> {
    if (!this.backupKey) return false;
    const stored = await this.client.backup(this.namespace).catch(() => null);
    if (!stored || stored.seq <= (await this.backupSeq())) return false;
    const blob = JSON.parse(stored.blob) as { sealed: string };
    this.wallet = await this.prover.unlockWallet(blob.sealed, this.backupKey);
    await this.save();
    return true;
  }

  /** Monotonic per wallet: the profile version first (a wallet that sets a
   * new account up publishes a higher version and its backups must win),
   * then this account's state version. */
  private async backupSeq(): Promise<number> {
    const v = await this.view();
    const profile = await this.profile();
    return (profile?.version ?? 1) * 2 ** 32 + v.history.length + v.receipts.length + (v.registered ? 1 : 0);
  }

  view(): Promise<WalletView> {
    return this.prover.walletView(this.wallet);
  }

  /** A manual backup file protected by a recovery code (argon2id). */
  exportBackup(code: string): Promise<string> {
    return this.prover.exportBackup(this.wallet, normalizeRecoveryCode(code) ?? code);
  }

  // ---- backups ----------------------------------------------------------------

  hasRecovery(): boolean {
    return this.backupKey !== null;
  }

  /** Seal the current state and upload it. The node stores ciphertext only
   * and refuses a lower state version. Failures are not fatal to the flow
   * that triggered them; the next state change tries again. */
  async backupNow(): Promise<boolean> {
    if (!this.backupKey) return false;
    const profile = await this.profile();
    const mechanism: RecoveryMechanism = profile?.recovery ?? 'wallet-signature';
    const sealed = await this.prover.lockWallet(this.wallet, this.backupKey);
    const wrapped = mechanism === 'recovery-code' ? await this.store.get(key(this.namespace, 'backup-wrapped')) : null;
    const seq = await this.backupSeq();
    try {
      await this.client.putBackup(this.namespace, { seq, mechanism, blob: JSON.stringify(wrapped ? { sealed, wrapped } : { sealed }) });
      return true;
    } catch {
      return false;
    }
  }

  private async saveAndBackup(): Promise<void> {
    await this.save();
    await this.backupNow();
  }

  // ---- profile (the account authorization) -------------------------------------

  /** The receiving profile this device holds for the account. */
  async profile(): Promise<Profile | null> {
    const raw = await this.store.get(key(this.namespace, 'profile'));
    return raw ? (JSON.parse(raw) as Profile) : null;
  }

  /** The wallet address the account is authorized by, from the profile. */
  async walletAddress(): Promise<string | null> {
    return (await this.profile())?.wallet ?? null;
  }

  /** Sign and publish a new profile version (setup, rename, key rotation
   * after `register`, or revocation). One wallet signature. */
  async publishProfile(signer: WalletSigner, displayName: string, recovery: RecoveryMechanism, revoked = false): Promise<Profile> {
    const v = await this.view();
    // Chain onto the directory's latest version for this wallet, so a wallet
    // that sets up again (a new account after losing everything, or a key
    // rotation) publishes a successor rather than a conflicting first version.
    const previous = (await this.profile()) ?? (await this.client.profile(this.namespace, signer.address).catch(() => null))?.profile ?? null;
    const now = Math.floor(Date.now() / 1000);
    const unsigned: UnsignedProfile = {
      version: (previous?.version ?? 0) + 1,
      wallet: signer.address.toLowerCase(),
      chain_id: signer.chainId,
      namespace: this.namespace,
      account: v.account,
      enc_key: v.enc_pubkey,
      profile_key: JSON.parse(await this.prover.keyBinding(this.wallet, 1)).pubkey as string,
      display_name: displayName,
      recovery,
      nonce: randomHex32(),
      issued_at: now,
      expiry: now + PROFILE_VALIDITY_SECS,
      prev: previous ? profileHash(previous) : '0'.repeat(64),
      revoked,
    };
    const signature = await signer.signTypedData(profileTypedData(unsigned));
    const profile: Profile = { ...unsigned, signature };
    await this.client.putProfile(profile);
    await this.store.set(key(this.namespace, 'profile'), JSON.stringify(profile));
    return profile;
  }

  /** Resolve a wallet address to a verified receiving profile. Returns null
   * when the address never activated private receiving; throws when the
   * directory's answer does not verify (a substituted key, a foreign ledger,
   * an expired or revoked profile). */
  async resolve(address: string): Promise<{ profile: Profile; hash: string } | null> {
    const entry = await this.client.profile(this.namespace, address);
    if (!entry) return null;
    const p = entry.profile;
    if (p.wallet !== address.toLowerCase()) throw new Error('directory answered for another address');
    if (p.namespace.toLowerCase() !== this.namespace.toLowerCase()) throw new Error('profile is for another ledger domain');
    if (p.revoked) throw new Error('this address stopped receiving private payments');
    if (p.expiry * 1000 < Date.now()) throw new Error('the receiving profile has expired; ask the recipient to renew it');
    if (!(await verifyProfile(p, this.publicClient))) throw new Error('the receiving profile does not verify; not paying');
    const hash = profileHash(p);
    if (hash !== entry.hash.replace(/^0x/, '')) throw new Error('directory hash mismatch');
    return { profile: p, hash };
  }

  // ---- registration ------------------------------------------------------

  /** Register on the ledger and publish the encryption key. Idempotent. */
  async register(): Promise<void> {
    const v = await this.view();
    if (!v.registered) {
      const onLedger = await this.client.account(this.namespace, v.account);
      if (!onLedger) {
        const env = JSON.parse(await this.prover.registerEnvelope(this.wallet));
        try {
          await this.client.register(this.namespace, env);
        } catch (e) {
          if (!(e instanceof LinksApiError && e.code === 'account_exists')) throw e;
        }
      }
      this.wallet = await this.prover.markRegistered(this.wallet);
      await this.save();
    }
    const existing = (await this.client.keyBinding(this.namespace, v.account)) as { seq?: number; enc_pubkey?: string } | null;
    if (!existing || existing.enc_pubkey !== v.enc_pubkey) {
      const seq = (existing?.seq ?? 0) + 1;
      await this.client.bindKey(JSON.parse(await this.prover.keyBinding(this.wallet, seq)));
    }
  }

  // ---- funding -----------------------------------------------------------

  /** Prepare a deposit of `amount` base units: proves R_dep, saves the
   * opening locally, registers the intent with the node, and returns the
   * receipt commitment the on-chain deposit must carry. */
  prepareDeposit(amount: string, reference: string | null = null): Promise<{ receipt: string; amount: string }> {
    return this.locked(() => this.prepareDepositUnlocked(amount, reference));
  }

  private async prepareDepositUnlocked(amount: string, reference: string | null = null): Promise<{ receipt: string; amount: string }> {
    const r = await this.prover.prepareDeposit(this.wallet, amount, reference);
    this.wallet = r.wallet;
    await this.saveAndBackup();
    await this.client.registerDepositIntent(r.value);
    return { receipt: r.value.receipt, amount };
  }

  /** Check pending deposits against the node and record mints. Returns the
   * receipts that were credited during this call. */
  syncDeposits(): Promise<string[]> {
    return this.locked(() => this.syncDepositsUnlocked());
  }

  private async syncDepositsUnlocked(): Promise<string[]> {
    const v = await this.view();
    const credited: string[] = [];
    for (const receipt of v.pending_deposits) {
      const st = await this.client.depositIntent(this.namespace, receipt);
      if (st.status === 'minted' && st.position !== null) {
        this.wallet = await this.prover.depositMinted(this.wallet, receipt, st.position);
        credited.push(receipt);
      }
    }
    if (credited.length) await this.saveAndBackup();
    return credited;
  }

  // ---- receipts and claims ------------------------------------------------

  private async fetchPath(position: number): Promise<{ json: string; path: ReceiptPath }> {
    const path = await this.client.receiptPath(this.namespace, position);
    return { json: JSON.stringify({ root: path.root, siblings: path.siblings, index_bits: path.index_bits }), path };
  }

  /** Pull new inbox envelopes, decrypt them, and record the receipts. */
  syncInbox(): Promise<number> {
    return this.locked(() => this.syncInboxUnlocked());
  }

  private async syncInboxUnlocked(): Promise<number> {
    const v = await this.view();
    const cursorKey = key(this.namespace, 'inbox-cursor');
    let after = Number((await this.store.get(cursorKey)) ?? '0');
    const auth = await this.prover.inboxAuth(this.wallet);
    const { items } = await this.client.inbox(this.namespace, v.account, auth, after);
    let added = 0;
    for (const item of items) {
      try {
        const d = JSON.parse(await this.prover.openReceipt(this.wallet, JSON.stringify(item.envelope))) as Delivery;
        this.wallet = await this.prover.addReceipt(this.wallet, d.position, JSON.stringify(d.opening), item.request_id ?? d.reference);
        added++;
      } catch {
        // Not for us, or garbage: skip. The inbox is public-write.
      }
      after = item.id;
    }
    if (items.length) {
      await this.saveAndBackup();
      await this.store.set(cursorKey, String(after));
    }
    return added;
  }

  /** Verify every discovered receipt against the ledger. */
  verifyReceipts(): Promise<void> {
    return this.locked(() => this.verifyReceiptsUnlocked());
  }

  private async verifyReceiptsUnlocked(): Promise<void> {
    const v = await this.view();
    let changed = false;
    for (let i = 0; i < v.receipts.length; i++) {
      const r = v.receipts[i]!;
      if (r.status !== 'discovered') continue;
      const { json } = await this.fetchPath(r.position);
      const out = await this.prover.verifyReceipt(this.wallet, i, json);
      this.wallet = out.wallet;
      changed = true;
    }
    if (changed) await this.save();
  }

  /** Claim held receipt `idx` (must be `unclaimed`). Returns the position of
   * the operation's own receipt (the dummy). */
  claim(idx: number): Promise<number> {
    return this.locked(() => this.claimUnlocked(idx));
  }

  private async claimUnlocked(idx: number): Promise<number> {
    const { json } = await this.fetchPath((await this.view()).receipts[idx]!.position);
    const out = await this.prover.receive(this.wallet, idx, json);
    this.wallet = out.wallet;
    await this.save(); // pending, before submission
    return this.submitPending(out.value);
  }

  /** Claim every verified, unclaimed receipt. Returns how many were claimed. */
  claimAll(): Promise<number> {
    return this.locked(() => this.claimAllUnlocked());
  }

  private async claimAllUnlocked(): Promise<number> {
    let n = 0;
    for (;;) {
      const v = await this.view();
      if (v.pending) break;
      const idx = v.receipts.findIndex((r) => r.status === 'unclaimed');
      if (idx < 0) break;
      await this.claimUnlocked(idx);
      n++;
    }
    return n;
  }

  /** Submit a proved pending operation and settle the journal. */
  private async submitPending(envelope: unknown): Promise<number> {
    try {
      const applied = await this.client.apply(this.namespace, envelope);
      this.wallet = await this.prover.commitPending(this.wallet, applied.position!);
      await this.saveAndBackup();
      return applied.position!;
    } catch (e) {
      if (e instanceof LinksApiError && e.status !== 0) {
        // The ledger answered and refused: abort locally.
        this.wallet = await this.prover.abortPending(this.wallet);
        await this.save();
        throw e;
      }
      // Unknown outcome (network): resolve from the ledger.
      const r = await this.reconcile();
      if (r === 'committed') {
        const v = await this.view();
        return v.history[v.history.length - 1]?.position ?? -1;
      }
      throw e;
    }
  }

  /** Resolve a pending operation (or none) against the ledger's commitment.
   * Safe to call any time; returns what happened. */
  async reconcile(): Promise<'in_sync' | 'committed' | 'aborted' | 'conflict'> {
    const v = await this.view();
    const onLedger = await this.client.account(this.namespace, v.account);
    if (!onLedger) return v.registered ? 'conflict' : 'in_sync';
    let position: number | null = null;
    if (v.pending) {
      // The accepted op's receipt position: the op at the account's
      // `updated_seq` in the public log is the one that set its commitment.
      const { ops } = await this.client.history(this.namespace, onLedger.updated_seq, 1);
      const op = ops[0];
      if (op && op.seq === onLedger.updated_seq && op.envelope.account === v.account) position = op.position;
    }
    const r = await this.prover.reconcile(this.wallet, onLedger.com, position);
    this.wallet = r.wallet;
    await this.save();
    return r.value;
  }

  // ---- paying --------------------------------------------------------------

  /** The amount, receiving details and reference of a target. */
  private async targetDetails(target: PaymentTarget): Promise<{
    amount: string;
    receiverAccount: string;
    receiverEncKey: string;
    reference: string | null;
    requestId: string;
    profileHash: string;
  }> {
    if ('request' in target) {
      const m = target.request.manifest;
      if (m.namespace !== this.namespace) throw new Error('request is for another asset domain');
      await this.prover.verifyRequest(JSON.stringify(m));
      if (target.request.status !== 'active') throw new Error(`request is ${target.request.status}`);
      if (m.expires_at !== null && m.expires_at * 1000 < Date.now()) throw new Error('request has expired');
      return {
        amount: m.amount,
        receiverAccount: m.receiver_account,
        receiverEncKey: m.receiver_enc_key,
        reference: m.request_id,
        requestId: m.request_id,
        profileHash: '0'.repeat(64),
      };
    }
    const p = target.profile;
    if (p.namespace.toLowerCase() !== this.namespace.toLowerCase()) throw new Error('profile is for another ledger domain');
    if (!/^\d+$/.test(target.amount) || BigInt(target.amount) === 0n) throw new Error('amount must be a positive integer');
    return {
      amount: target.amount,
      receiverAccount: p.account,
      receiverEncKey: p.enc_key,
      reference: target.reference ?? null,
      requestId: '',
      profileHash: target.profileHash,
    };
  }

  /** The intent the wallet is asked to confirm for `target` (decision 0011). */
  async paymentIntentFor(target: PaymentTarget): Promise<PaymentIntent> {
    const d = await this.targetDetails(target);
    const v = await this.view();
    return {
      amount: d.amount,
      recipient_profile_hash: d.profileHash,
      request_id: d.requestId,
      namespace: this.namespace,
      account_state_version: v.history.length,
      nonce: randomHex32(),
      expiry: Math.floor(Date.now() / 1000) + 600,
    };
  }

  /** Pay a request or a resolved address: verify the target, check the
   * wallet's local approval (when given), reserve a request, prove and
   * submit the send, then deliver the encrypted opening to the receiver's
   * inbox. */
  pay(target: PaymentTarget, intentId: string, approval?: PaymentApproval): Promise<PayResult> {
    return this.locked(() => this.payUnlocked(target, intentId, approval));
  }

  private async payUnlocked(target: PaymentTarget, intentId: string, approval?: PaymentApproval): Promise<PayResult> {
    const d = await this.targetDetails(target);
    const v = await this.view();
    if (v.pending) throw new Error('an operation is pending; reconcile first');
    if (BigInt(v.balance) < BigInt(d.amount)) throw new Error('insufficient balance');
    if (approval) {
      const wallet = await this.walletAddress();
      const chainId = (await this.profile())?.chain_id;
      if (!wallet || chainId === undefined) throw new Error('no wallet is bound to this account');
      const i = approval.intent;
      if (i.amount !== d.amount || i.request_id !== d.requestId || i.recipient_profile_hash !== d.profileHash || i.namespace !== this.namespace) {
        throw new Error('the wallet approved a different payment');
      }
      if (!(await verifyPaymentIntent(i, chainId, approval.signature, wallet, this.publicClient))) {
        throw new Error('the wallet approval does not verify');
      }
    }
    if (d.requestId) await this.client.reserveRequest(d.requestId, intentId);
    const summary = await this.client.ledger(this.namespace);
    const out = await this.prover.send(this.wallet, d.amount, d.receiverAccount, summary.receipt_root, d.reference);
    this.wallet = out.wallet;
    await this.save(); // pending + opening journaled before submission
    const position = await this.submitPending(out.envelope);
    if (!('request' in target)) await this.label(position, target.profile.wallet);
    const envelope = JSON.parse(
      await this.prover.sealReceipt(this.namespace, d.receiverEncKey, JSON.stringify(out.opening), position, d.reference),
    );
    const delivered = await this.deliver({ account: d.receiverAccount, envelope, request_id: d.requestId || null });
    return { position, delivered };
  }

  private async deliver(entry: OutboxEntry): Promise<boolean> {
    try {
      await this.client.postInbox(this.namespace, entry.account, entry.envelope, entry.request_id);
      return true;
    } catch {
      const k = key(this.namespace, 'outbox');
      const outbox = JSON.parse((await this.store.get(k)) ?? '[]') as OutboxEntry[];
      outbox.push(entry);
      await this.store.set(k, JSON.stringify(outbox));
      return false;
    }
  }

  /** Retry undelivered receipt envelopes. Returns how many remain. */
  async flushOutbox(): Promise<number> {
    const k = key(this.namespace, 'outbox');
    const outbox = JSON.parse((await this.store.get(k)) ?? '[]') as OutboxEntry[];
    const remaining: OutboxEntry[] = [];
    for (const entry of outbox) {
      try {
        await this.client.postInbox(this.namespace, entry.account, entry.envelope, entry.request_id);
      } catch {
        remaining.push(entry);
      }
    }
    await this.store.set(k, JSON.stringify(remaining));
    return remaining.length;
  }

  // ---- labels (device-local names for history entries) -----------------------

  /** Remember the wallet address a send went to, for this device's history. */
  async label(position: number, address: string): Promise<void> {
    const k = key(this.namespace, 'labels');
    const labels = JSON.parse((await this.store.get(k)) ?? '{}') as Record<string, string>;
    labels[String(position)] = address.toLowerCase();
    await this.store.set(k, JSON.stringify(labels));
  }

  async labels(): Promise<Record<string, string>> {
    return JSON.parse((await this.store.get(key(this.namespace, 'labels'))) ?? '{}') as Record<string, string>;
  }

  // ---- withdrawals -------------------------------------------------------------

  /** Burn `amount` on the ledger (a send to the withdraw identifier) and
   * obtain the committee certificate releasing it to `recipient` on the
   * backing chain. The caller submits the certificate to the gateway with
   * a wallet (`withdrawOnChain`). Returns the burn position and the
   * certificate. */
  withdraw(amount: string, recipient: string): Promise<{ position: number; certificate: WithdrawalCertificate }> {
    return this.locked(() => this.withdrawUnlocked(amount, recipient));
  }

  private async withdrawUnlocked(amount: string, recipient: string): Promise<{ position: number; certificate: WithdrawalCertificate }> {
    const v = await this.view();
    if (v.pending) throw new Error('an operation is pending; reconcile first');
    if (BigInt(v.balance) < BigInt(amount)) throw new Error('insufficient balance');
    const summary = await this.client.ledger(this.namespace);
    const out = await this.prover.withdraw(this.wallet, amount, recipient, summary.receipt_root);
    this.wallet = out.wallet;
    await this.save();
    const position = await this.submitPending(out.envelope);
    const certificate = await this.settle(position);
    return { position, certificate };
  }

  /** Ask the settlement path for the certificate of a burn at `position`.
   * Idempotent: a certificate already issued is returned again. */
  async settle(position: number): Promise<WithdrawalCertificate> {
    const claim = JSON.parse(await this.prover.withdrawalClaim(this.wallet, position));
    return this.client.settleWithdrawal(claim);
  }

  // ---- requests --------------------------------------------------------------

  /** Create a payment link. Signed by the account's key (authorized under
   * the profile), so no wallet popup; the manifest names the wallet. */
  async createRequest(input: { amount: string; title: string; reference?: string | null; expiresAt?: number | null }): Promise<PaymentRequest> {
    const profile = await this.profile();
    if (!profile) throw new Error('publish a receiving profile first');
    const id = await this.prover.newRequestId();
    const manifest = JSON.parse(
      await this.prover.signRequest(
        this.wallet,
        id,
        input.amount,
        input.title,
        profile.display_name,
        profile.wallet,
        input.reference ?? null,
        input.expiresAt ?? null,
      ),
    );
    return this.client.createRequest(manifest);
  }

  /** Tell the request API that a payment for `requestId` was claimed at
   * `position`. Optional and receiver-signed; discloses that the receiver
   * claimed, nothing else. */
  async acknowledge(requestId: string, position: number): Promise<void> {
    const ack = JSON.parse(await this.prover.fulfillmentAck(this.wallet, requestId, position));
    await this.client.fulfillRequest(requestId, ack);
  }

  /** One sync pass: deposits, inbox, verification, outbox. */
  /** Pull everything new, and check this copy of the wallet against the
   * ledger. A copy that is behind (another tab or device acted for the
   * account) is brought forward from the node's backup; `stale` says so. */
  sync(): Promise<{ credited: number; discovered: number; stale: boolean }> {
    return this.locked(async () => {
      let stale = false;
      const v0 = await this.view();
      if (v0.registered && !v0.pending && (await this.reconcile()) === 'conflict') {
        stale = await this.refreshFromBackup();
      }
      const credited = (await this.syncDepositsUnlocked()).length;
      const discovered = await this.syncInboxUnlocked();
      await this.verifyReceiptsUnlocked();
      await this.flushOutbox();
      return { credited, discovered, stale };
    });
  }
}
