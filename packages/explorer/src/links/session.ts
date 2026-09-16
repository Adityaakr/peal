// Peal Links client session for the explorer: the node client, the prover
// worker, parameter loading, the private account, and sign-in.
//
// Four things stay separate, as the spec requires:
// - EVM ownership: the connected wallet (Privy, or an injected provider),
//   used to sign the sign-in message and, in Phase D, deposits;
// - private spending authority and encryption keys: inside the wasm wallet,
//   encrypted at rest in IndexedDB under a passphrase;
// - recovery material: the exported backup file;
// - the product session: a bearer token the node issues after sign-in.
//
// Module-level state with a tiny subscription, in the style of auth.tsx, so
// the vanilla pages can read it and re-render.

import {
  createRemoteProver,
  indexedDbStore,
  LinksAccount,
  loadParams,
  NodeClient,
  siweMessage,
  type AsyncProver,
  type LinksStatus,
  type NamespaceInfo,
  type WalletStore,
} from 'peal-links';
import { session as evmSession, type Eip1193Like } from '../auth';

export interface LinksSession {
  status: LinksStatus | null;
  statusError: string | null;
  /** Selected asset domain. */
  namespace: NamespaceInfo | null;
  /** Proving keys loaded into the worker. */
  paramsReady: boolean;
  paramsProgress: string;
  /** An encrypted account exists in this browser for the namespace. */
  hasStoredAccount: boolean;
  /** Unlocked account, if any. */
  account: LinksAccount | null;
  /** Signed-in EVM address for the product API, if any. */
  signedIn: string | null;
  autoClaim: boolean;
}

let state: LinksSession = {
  status: null,
  statusError: null,
  namespace: null,
  paramsReady: false,
  paramsProgress: '',
  hasStoredAccount: false,
  account: null,
  signedIn: null,
  autoClaim: false,
};

const listeners = new Set<() => void>();

export function links(): LinksSession {
  return state;
}

export function onLinksChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function publish(next: Partial<LinksSession>): void {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

export const client = new NodeClient({ baseUrl: (import.meta.env.VITE_LINKS_URL as string | undefined) ?? '' });
export const store: WalletStore = indexedDbStore('peal-links');

let prover: AsyncProver | null = null;
let paramsPromise: Promise<void> | null = null;

export function getProver(): AsyncProver {
  if (prover) return prover;
  const worker = new Worker(new URL('./prover.worker.ts', import.meta.url), { type: 'module' });
  const created = createRemoteProver(worker);
  prover = created;
  return created;
}

/** Fetch the node status once and pick the first namespace. */
export async function loadStatus(): Promise<LinksStatus | null> {
  try {
    const status = await client.status();
    const namespace = state.namespace ?? status.namespaces[0] ?? null;
    const hasStoredAccount = namespace ? await LinksAccount.exists(store, namespace.id) : false;
    publish({ status, statusError: null, namespace, hasStoredAccount });
    return status;
  } catch (e) {
    publish({ status: null, statusError: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export async function selectNamespace(ns: NamespaceInfo): Promise<void> {
  const hasStoredAccount = await LinksAccount.exists(store, ns.id);
  publish({ namespace: ns, hasStoredAccount, account: null });
}

/** Load proving keys into the worker (cached by digest in IndexedDB). */
export function ensureParams(): Promise<void> {
  if (!paramsPromise) {
    publish({ paramsProgress: 'loading proving keys' });
    paramsPromise = loadParams(client, getProver(), store)
      .then(() => publish({ paramsReady: true, paramsProgress: '' }))
      .catch((e) => {
        paramsPromise = null;
        publish({ paramsProgress: '' });
        throw e;
      });
  }
  return paramsPromise;
}

function opts(ns: NamespaceInfo) {
  return { prover: getProver(), client, namespace: ns.id, store };
}

export async function createAccount(passphrase: string): Promise<LinksAccount> {
  const { status, namespace } = state;
  if (!status || !namespace) throw new Error('node status not loaded');
  await ensureParams();
  const account = await LinksAccount.create(opts(namespace), status.circuit_id, passphrase);
  await account.register();
  publish({ account, hasStoredAccount: true });
  return account;
}

export async function openAccount(passphrase: string): Promise<LinksAccount> {
  const { namespace } = state;
  if (!namespace) throw new Error('node status not loaded');
  await ensureParams();
  const account = await LinksAccount.open(opts(namespace), passphrase);
  await account.register(); // idempotent: also re-publishes the key binding
  publish({ account });
  return account;
}

export async function restoreAccount(backupJson: string, backupPassphrase: string, passphrase: string): Promise<LinksAccount> {
  const { namespace } = state;
  if (!namespace) throw new Error('node status not loaded');
  await ensureParams();
  const account = await LinksAccount.restore(opts(namespace), backupJson, backupPassphrase, passphrase);
  await account.register();
  publish({ account, hasStoredAccount: true });
  return account;
}

export function lockAccount(): void {
  publish({ account: null, autoClaim: false });
}

export function signOut(): void {
  client.token = null;
  try {
    localStorage.removeItem('peal-links:session');
  } catch {
    /* storage unavailable */
  }
  publish({ signedIn: null });
}

export function setAutoClaim(on: boolean): void {
  publish({ autoClaim: on });
}

/** Sign in to the request API with the connected EVM wallet (EIP-4361). */
export async function signIn(): Promise<string> {
  const evm = evmSession();
  if (!evm.address || !evm.provider) throw new Error('connect a wallet first');
  const { nonce } = await client.nonce();
  const message = siweMessage({
    domain: location.host,
    address: evm.address,
    uri: `${location.origin}/bonsai/app`,
    chainId: state.namespace?.chain_id ?? evm.chainId ?? 1,
    nonce,
  });
  const signature = (await personalSign(evm.provider, evm.address, message)) as string;
  const s = await client.session(message, signature);
  try {
    localStorage.setItem('peal-links:session', JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
  publish({ signedIn: s.address });
  return s.address;
}

/** Resume a product session from this browser's storage, if still valid.
 * The token authorizes request metadata only, never value; it lives in
 * localStorage so a new tab does not need a fresh signature. */
export async function resumeSignIn(): Promise<void> {
  try {
    const raw = localStorage.getItem('peal-links:session');
    if (!raw) return;
    const s = JSON.parse(raw) as { token: string; address: string; expires_at: number };
    if (s.expires_at * 1000 < Date.now()) return;
    client.token = s.token;
    await client.me();
    publish({ signedIn: s.address });
  } catch {
    client.token = null;
  }
}

async function personalSign(provider: Eip1193Like, address: string, message: string): Promise<unknown> {
  const hex = `0x${Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  return provider.request({ method: 'personal_sign', params: [hex, address] });
}
