// The prover interface the SDK programs against, and two ways to get one:
// in-thread (Node tests, workers) and remote (the page talks to a worker).
//
// Every method mirrors a `Prover` method in crates/peal-links-wasm. Wallet
// state is an opaque JSON string that only the wasm side reads; the SDK
// moves it between the prover, storage and the node.

import type { Prover } from './generated/peal_links_wasm.js';
import { ensureWasm } from './wasm.js';

export interface KeyInfo {
  circuit_id: string;
  op_vk_digest: string;
  deposit_vk_digest: string;
}

export interface ReceiptOpening {
  amount: string;
  sender: string;
  receiver: string;
  randomness: string;
}

export interface Delivery {
  opening: ReceiptOpening;
  position: number;
  reference: string | null;
}

export interface OpEnvelope {
  namespace: string;
  circuit_id: string;
  account: string;
  com: string;
  com_new: string;
  receipt: string;
  root: string;
  proof: string;
  pubkey: string;
  signature: string;
}

export interface DepositIntent {
  namespace: string;
  circuit_id: string;
  amount: number;
  receipt: string;
  proof: string;
}

export interface ReceiptView {
  position: number;
  receipt: string;
  amount: string;
  sender: string;
  status: 'discovered' | 'verified' | 'unclaimed' | 'claiming' | 'claimed' | 'invalid';
  reference: string | null;
  discovered_at: number;
}

export interface HistoryView {
  seq: number;
  kind: 'send' | 'receive';
  amount: string;
  counterparty: string;
  position: number | null;
  reference: string | null;
  at: number;
}

export interface WalletView {
  namespace: string;
  circuit_id: string;
  account: string;
  enc_pubkey: string;
  registered: boolean;
  balance: string;
  unclaimed: string;
  pending: 'send' | 'receive' | null;
  pending_deposits: string[];
  receipts: ReceiptView[];
  history: HistoryView[];
  commitment: string;
}

/** Every prover method, asynchronous, so the same code drives an in-thread
 * wasm instance or a worker. */
export interface AsyncProver {
  loadKeys(opPk: Uint8Array, opVk: Uint8Array, depPk: Uint8Array, depVk: Uint8Array, circuitId: string): Promise<KeyInfo>;
  hasKeys(): Promise<boolean>;
  createWallet(namespace: string, circuitId: string): Promise<string>;
  walletView(wallet: string): Promise<WalletView>;
  registerEnvelope(wallet: string): Promise<string>;
  markRegistered(wallet: string): Promise<string>;
  keyBinding(wallet: string, seq: number): Promise<string>;
  inboxAuth(wallet: string): Promise<string>;
  prepareDeposit(wallet: string, amount: string, reference: string | null): Promise<{ wallet: string; value: DepositIntent }>;
  depositMinted(wallet: string, receipt: string, position: number): Promise<string>;
  addReceipt(wallet: string, position: number, openingJson: string, reference: string | null): Promise<string>;
  verifyReceipt(wallet: string, idx: number, pathJson: string): Promise<{ wallet: string; value: boolean }>;
  send(wallet: string, amount: string, to: string, root: string, reference: string | null): Promise<{ wallet: string; envelope: OpEnvelope; opening: ReceiptOpening }>;
  receive(wallet: string, idx: number, pathJson: string): Promise<{ wallet: string; value: OpEnvelope }>;
  commitPending(wallet: string, position: number): Promise<string>;
  abortPending(wallet: string): Promise<string>;
  reconcile(wallet: string, ledgerCom: string, position: number | null): Promise<{ wallet: string; value: 'in_sync' | 'committed' | 'aborted' | 'conflict' }>;
  commitment(wallet: string): Promise<string>;
  newRequestId(): Promise<string>;
  signRequest(wallet: string, requestId: string, amount: string, title: string, displayName: string, reference: string | null, expiresAt: number | null): Promise<string>;
  verifyRequest(manifestJson: string): Promise<void>;
  fulfillmentAck(wallet: string, requestId: string, position: number): Promise<string>;
  sealReceipt(namespace: string, recipientEncKey: string, openingJson: string, position: number, reference: string | null): Promise<string>;
  openReceipt(wallet: string, envelopeJson: string): Promise<string>;
  exportBackup(wallet: string, passphrase: string): Promise<string>;
  importBackup(backupJson: string, passphrase: string): Promise<string>;
  newStorageKey(): Promise<string>;
  wrapKey(keyHex: string, passphrase: string): Promise<string>;
  unwrapKey(wrappedJson: string, passphrase: string): Promise<string>;
  lockWallet(wallet: string, keyHex: string): Promise<string>;
  unlockWallet(lockedJson: string, keyHex: string): Promise<string>;
}

/** The method table: SDK name -> wasm name. Shared by the in-thread adapter
 * and the worker so the two cannot drift. */
export const PROVER_METHODS = {
  loadKeys: 'load_keys',
  hasKeys: 'has_keys',
  createWallet: 'create_wallet',
  walletView: 'wallet_view',
  registerEnvelope: 'register_envelope',
  markRegistered: 'mark_registered',
  keyBinding: 'key_binding',
  inboxAuth: 'inbox_auth',
  prepareDeposit: 'prepare_deposit',
  depositMinted: 'deposit_minted',
  addReceipt: 'add_receipt',
  verifyReceipt: 'verify_receipt',
  send: 'send',
  receive: 'receive',
  commitPending: 'commit_pending',
  abortPending: 'abort_pending',
  reconcile: 'reconcile',
  commitment: 'commitment',
  newRequestId: 'new_request_id',
  signRequest: 'sign_request',
  verifyRequest: 'verify_request',
  fulfillmentAck: 'fulfillment_ack',
  sealReceipt: 'seal_receipt',
  openReceipt: 'open_receipt',
  exportBackup: 'export_backup',
  importBackup: 'import_backup',
  newStorageKey: 'new_storage_key',
  wrapKey: 'wrap_key',
  unwrapKey: 'unwrap_key',
  lockWallet: 'lock_wallet',
  unlockWallet: 'unlock_wallet',
} as const;

/** wasm-bindgen maps u64 to bigint; these argument positions carry one. */
const BIGINT_ARGS: Partial<Record<keyof typeof PROVER_METHODS, number[]>> = {
  keyBinding: [1],
  depositMinted: [2],
  addReceipt: [1],
  commitPending: [1],
  reconcile: [2],
  signRequest: [6],
  fulfillmentAck: [2],
  sealReceipt: [3],
};

function coerceArgs(name: keyof typeof PROVER_METHODS, args: unknown[]): unknown[] {
  const positions = BIGINT_ARGS[name] ?? [];
  return args.map((a, i) => (positions.includes(i) && typeof a === 'number' ? BigInt(a) : a));
}

/** Normalise wasm results: bigint -> number where the SDK promised one. */
function normalise(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    if (value instanceof Map) return Object.fromEntries(Array.from(value.entries(), ([k, v]) => [k, normalise(v)]));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalise(v);
    return out;
  }
  return value;
}

/** Call a wasm `Prover` method by SDK name. */
export function callProver(prover: Prover, name: keyof typeof PROVER_METHODS, args: unknown[]): unknown {
  const method = PROVER_METHODS[name];
  const fn = (prover as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
  if (typeof fn !== 'function') throw new Error(`prover has no method ${method}`);
  return normalise(fn.apply(prover, coerceArgs(name, args)));
}

/** An in-thread prover: loads the wasm and answers every call directly.
 * Use in Node, in tests, and inside the worker. */
export async function createLocalProver(): Promise<AsyncProver> {
  const ProverClass = await ensureWasm();
  const prover = new ProverClass();
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const name of Object.keys(PROVER_METHODS) as Array<keyof typeof PROVER_METHODS>) {
    out[name] = async (...args: unknown[]) => callProver(prover, name, args);
  }
  return out as unknown as AsyncProver;
}
