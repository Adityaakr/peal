// A private account on one namespace: the wallet state, its encrypted local
// storage, and every flow the product needs (register, fund, pay a request,
// sync the inbox, claim, withdraw later, back up, recover).
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

import { LinksApiError, NodeClient, type PaymentRequest, type ReceiptPath, type WithdrawalCertificate } from './client.js';
import type { AsyncProver, Delivery, WalletView } from './prover.js';

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
}

const key = (ns: string, what: string) => `peal-links:${ns}:${what}`;

export class LinksAccount {
  private wallet: string;
  private readonly prover: AsyncProver;
  private readonly client: NodeClient;
  readonly namespace: string;
  private readonly store: WalletStore;
  private readonly storageKey: string;

  private constructor(opts: AccountOptions, wallet: string, storageKey: string) {
    this.prover = opts.prover;
    this.client = opts.client;
    this.namespace = opts.namespace;
    this.store = opts.store;
    this.wallet = wallet;
    this.storageKey = storageKey;
  }

  /** Whether an encrypted wallet exists in the store for this namespace. */
  static async exists(store: WalletStore, namespace: string): Promise<boolean> {
    return (await store.get(key(namespace, 'wallet'))) !== null;
  }

  /** Create a fresh account, protected by `passphrase`. */
  static async create(opts: AccountOptions, circuitId: string, passphrase: string): Promise<LinksAccount> {
    if (await LinksAccount.exists(opts.store, opts.namespace)) throw new Error('an account already exists here; open or restore it');
    const wallet = await opts.prover.createWallet(opts.namespace, circuitId);
    const storageKey = await opts.prover.newStorageKey();
    await opts.store.set(key(opts.namespace, 'key'), await opts.prover.wrapKey(storageKey, passphrase));
    const acct = new LinksAccount(opts, wallet, storageKey);
    await acct.save();
    return acct;
  }

  /** Unlock the stored account. */
  static async open(opts: AccountOptions, passphrase: string): Promise<LinksAccount> {
    const wrapped = await opts.store.get(key(opts.namespace, 'key'));
    const locked = await opts.store.get(key(opts.namespace, 'wallet'));
    if (!wrapped || !locked) throw new Error('no account stored here');
    const storageKey = await opts.prover.unwrapKey(wrapped, passphrase);
    const wallet = await opts.prover.unlockWallet(locked, storageKey);
    return new LinksAccount(opts, wallet, storageKey);
  }

  /** Restore from an exported backup onto this device, protected here by
   * `passphrase` (which may differ from the backup's). */
  static async restore(opts: AccountOptions, backupJson: string, backupPassphrase: string, passphrase: string): Promise<LinksAccount> {
    const wallet = await opts.prover.importBackup(backupJson, backupPassphrase);
    const storageKey = await opts.prover.newStorageKey();
    await opts.store.set(key(opts.namespace, 'key'), await opts.prover.wrapKey(storageKey, passphrase));
    const acct = new LinksAccount(opts, wallet, storageKey);
    await acct.save();
    // Anti-rollback: a restored wallet is checked against the ledger before
    // it is used, so a stale backup cannot double-spend into a conflict
    // unnoticed.
    await acct.reconcile();
    return acct;
  }

  private async save(): Promise<void> {
    const locked = await this.prover.lockWallet(this.wallet, this.storageKey);
    await this.store.set(key(this.namespace, 'wallet'), locked);
  }

  view(): Promise<WalletView> {
    return this.prover.walletView(this.wallet);
  }

  exportBackup(passphrase: string): Promise<string> {
    return this.prover.exportBackup(this.wallet, passphrase);
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
  async prepareDeposit(amount: string, reference: string | null = null): Promise<{ receipt: string; amount: string }> {
    const r = await this.prover.prepareDeposit(this.wallet, amount, reference);
    this.wallet = r.wallet;
    await this.save();
    await this.client.registerDepositIntent(r.value);
    return { receipt: r.value.receipt, amount };
  }

  /** Check pending deposits against the node and record mints. Returns the
   * receipts that were credited during this call. */
  async syncDeposits(): Promise<string[]> {
    const v = await this.view();
    const credited: string[] = [];
    for (const receipt of v.pending_deposits) {
      const st = await this.client.depositIntent(this.namespace, receipt);
      if (st.status === 'minted' && st.position !== null) {
        this.wallet = await this.prover.depositMinted(this.wallet, receipt, st.position);
        credited.push(receipt);
      }
    }
    if (credited.length) await this.save();
    return credited;
  }

  // ---- receipts and claims ------------------------------------------------

  private async fetchPath(position: number): Promise<{ json: string; path: ReceiptPath }> {
    const path = await this.client.receiptPath(this.namespace, position);
    return { json: JSON.stringify({ root: path.root, siblings: path.siblings, index_bits: path.index_bits }), path };
  }

  /** Pull new inbox envelopes, decrypt them, and record the receipts. */
  async syncInbox(): Promise<number> {
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
      await this.save();
      await this.store.set(cursorKey, String(after));
    }
    return added;
  }

  /** Verify every discovered receipt against the ledger. */
  async verifyReceipts(): Promise<void> {
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
  async claim(idx: number): Promise<number> {
    const { json } = await this.fetchPath((await this.view()).receipts[idx]!.position);
    const out = await this.prover.receive(this.wallet, idx, json);
    this.wallet = out.wallet;
    await this.save(); // pending, before submission
    return this.submitPending(out.value);
  }

  /** Submit a proved pending operation and settle the journal. */
  private async submitPending(envelope: unknown): Promise<number> {
    try {
      const applied = await this.client.apply(this.namespace, envelope);
      this.wallet = await this.prover.commitPending(this.wallet, applied.position!);
      await this.save();
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

  /** Pay a request: verify its manifest, reserve it, prove and submit the
   * send, then deliver the encrypted opening to the receiver's inbox. */
  async pay(request: PaymentRequest, intentId: string): Promise<PayResult> {
    const m = request.manifest;
    if (m.namespace !== this.namespace) throw new Error('request is for another asset domain');
    await this.prover.verifyRequest(JSON.stringify(m));
    if (request.status !== 'active') throw new Error(`request is ${request.status}`);
    if (m.expires_at !== null && m.expires_at * 1000 < Date.now()) throw new Error('request has expired');
    const v = await this.view();
    if (v.pending) throw new Error('an operation is pending; reconcile first');
    if (BigInt(v.balance) < BigInt(m.amount)) throw new Error('insufficient balance');
    await this.client.reserveRequest(m.request_id, intentId);
    const summary = await this.client.ledger(this.namespace);
    const out = await this.prover.send(this.wallet, m.amount, m.receiver_account, summary.receipt_root, m.request_id);
    this.wallet = out.wallet;
    await this.save(); // pending + opening journaled before submission
    const position = await this.submitPending(out.envelope);
    const envelope = JSON.parse(
      await this.prover.sealReceipt(this.namespace, m.receiver_enc_key, JSON.stringify(out.opening), position, m.request_id),
    );
    const delivered = await this.deliver({ account: m.receiver_account, envelope, request_id: m.request_id });
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

  // ---- withdrawals -------------------------------------------------------------

  /** Burn `amount` on the ledger (a send to the withdraw identifier) and
   * obtain the committee certificate releasing it to `recipient` on the
   * backing chain. The caller submits the certificate to the gateway with
   * a wallet (`withdrawOnChain`). Returns the burn position and the
   * certificate. */
  async withdraw(amount: string, recipient: string): Promise<{ position: number; certificate: WithdrawalCertificate }> {
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

  async createRequest(input: {
    amount: string;
    title: string;
    displayName: string;
    reference?: string | null;
    expiresAt?: number | null;
  }): Promise<PaymentRequest> {
    const id = await this.prover.newRequestId();
    const manifest = JSON.parse(
      await this.prover.signRequest(this.wallet, id, input.amount, input.title, input.displayName, input.reference ?? null, input.expiresAt ?? null),
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
  async sync(): Promise<{ credited: number; discovered: number }> {
    const credited = (await this.syncDeposits()).length;
    const discovered = await this.syncInbox();
    await this.verifyReceipts();
    await this.flushOutbox();
    return { credited, discovered };
  }
}
