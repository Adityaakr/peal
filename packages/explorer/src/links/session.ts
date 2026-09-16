// Peal Links client session for the explorer: the node client, the prover
// worker, parameter loading, the private account behind the connected
// wallet, and sign-in.
//
// One wallet, private by default (SPEC-ADDENDUM-one-wallet.md): the person
// connects their EVM wallet and everything else happens here. On first use
// the wallet signs one receiving profile (decision 0011) and, where it can,
// the recovery message (decision 0012); the private account is provisioned
// in the wasm worker and sealed under a device key. On a later visit the
// account unlocks with no signature. On a fresh browser the profile in the
// directory says which recovery path applies.
//
// Four things stay separate: EVM ownership (the wallet), private spending
// authority and encryption keys (the wasm wallet, device-sealed), recovery
// material (derived key or code, never sent), and the product session (a
// bearer token the node issues after sign-in, no spending authority).

import {
  createRemoteProver,
  deriveBackupKey,
  deterministicSignature,
  gasSymbol,
  indexedDbDeviceKeys,
  indexedDbStore,
  isContractAddress,
  LinksAccount,
  loadParams,
  newIntentId,
  newRecoveryCode,
  NodeClient,
  paymentIntentTypedData,
  providerSigner,
  publicClientFor,
  recoveryMessage,
  siweMessage,
  type AsyncProver,
  type DeviceKeys,
  type LinksStatus,
  type NamespaceInfo,
  type PaymentRequest,
  type PayResult,
  type Profile,
  type RecoveryPlan,
  type WalletSigner,
  type WalletStore,
} from 'peal-links';
import type { EIP1193Provider } from 'viem';
import { session as evmSession, type Eip1193Like } from '../auth';
import { shortHex } from './format';

/** Where the person is in activating their private account. */
export type SetupState =
  | 'idle'
  | 'signing-in'
  | 'checking'
  | 'recovery-signature'
  | 'needs-recovery-code'
  | 'setting-up'
  | 'ready'
  | 'no-backup';

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
  setup: SetupState;
  setupDetail: string | null;
  /** The directory profile found for the connected wallet when this
   * browser holds no state for it (recovery pending). */
  recoveryProfile: Profile | null;
  /** A recovery code generated at setup, shown once until acknowledged. */
  newRecoveryCode: string | null;
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
  setup: 'idle',
  setupDetail: null,
  recoveryProfile: null,
  newRecoveryCode: null,
  autoClaim: readAutoClaim(),
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
export const deviceKeys: DeviceKeys = indexedDbDeviceKeys('peal-links-device');

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
  publish({ namespace: ns, hasStoredAccount, account: null, setup: 'idle', setupDetail: null, recoveryProfile: null });
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
  const evm = evmSession();
  return {
    prover: getProver(),
    client,
    namespace: ns.id,
    store,
    deviceKeys,
    publicClient: evm.provider ? publicClientFor(ns, evm.provider as unknown as EIP1193Provider) : undefined,
  };
}

/** Put the connected wallet on the namespace's chain before anything is
 * signed or sent: switch, and add the chain to the wallet first when it
 * does not know it (Tempo, local anvil). Reads the wallet's current chain
 * from the provider rather than trusting what was recorded at connect. */
export async function ensureWalletChain(ns: NamespaceInfo): Promise<void> {
  const evm = evmSession();
  if (!evm.provider) throw new Error('connect a wallet first');
  const current = Number.parseInt(String(await evm.provider.request({ method: 'eth_chainId' })), 16);
  if (current === ns.chain_id) return;
  const chainId = `0x${ns.chain_id.toString(16)}`;
  try {
    // The session's own switch knows the connector (Privy's embedded wallet
    // switches through its SDK; an injected wallet through EIP-3326).
    await evm.switchChain(ns.chain_id);
  } catch (e) {
    const code = (e as { code?: number }).code;
    const msg = e instanceof Error ? e.message : String(e);
    if (code === 4001 || /rejected|denied/i.test(msg)) {
      throw new Error(`Your wallet is on chain ${current} and the switch to ${ns.chain_name} (id ${ns.chain_id}) was declined. Switch it there yourself and try again.`);
    }
    if (code !== 4902 && !/unrecognized|not added|Unknown chain|4902/i.test(msg)) throw e;
    const symbol = gasSymbol(ns.chain_id);
    await evm.provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId,
          chainName: ns.chain_name,
          rpcUrls: [ns.rpc_url],
          nativeCurrency: { name: symbol, symbol, decimals: 18 },
          blockExplorerUrls: ns.explorer_url ? [ns.explorer_url] : [],
        },
      ],
    });
    await evm.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  }
  const after = Number.parseInt(String(await evm.provider.request({ method: 'eth_chainId' })), 16);
  if (after !== ns.chain_id) throw new Error(`your wallet is still on chain ${after}; switch it to ${ns.chain_name} (id ${ns.chain_id}) and try again`);
}

function walletSigner(ns: NamespaceInfo): WalletSigner {
  const evm = evmSession();
  if (!evm.address || !evm.provider) throw new Error('connect a wallet first');
  return providerSigner(evm.provider, evm.address, ns.chain_id);
}

function readAutoClaim(): boolean {
  try {
    return localStorage.getItem('peal-links:autoclaim') !== '0';
  } catch {
    return true;
  }
}

export function setAutoClaim(on: boolean): void {
  try {
    localStorage.setItem('peal-links:autoclaim', on ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
  publish({ autoClaim: on });
}

export function acknowledgeRecoveryCode(): void {
  publish({ newRecoveryCode: null });
}

export function lockAccount(): void {
  publish({ account: null, setup: 'idle', setupDetail: null });
}

/** Leave the wallet: end the product session, lock the account, and
 * disconnect the connector (Privy logs out; a browser wallet is forgotten). */
export function disconnect(): void {
  signOut();
  const evm = evmSession();
  evm.logout();
}

export function signOut(): void {
  client.token = null;
  try {
    localStorage.removeItem('peal-links:session');
  } catch {
    /* storage unavailable */
  }
  publish({ signedIn: null, account: null, setup: 'idle', setupDetail: null, recoveryProfile: null });
}

// ---- activation: the one-wallet flow ------------------------------------------

/** Bring the connected wallet's private account up: sign in, then unlock
 * this device's state, or recover from the backup the directory profile
 * points at, or set a new account up. The only wallet prompts are the
 * sign-in message, the profile signature (first use), and, for wallets that
 * sign deterministically, the recovery message. */
export async function activate(): Promise<LinksAccount | null> {
  const { status, namespace } = state;
  if (!status || !namespace) throw new Error('node status not loaded');
  const evm = evmSession();
  if (!evm.address || !evm.provider) throw new Error('connect a wallet first');
  const address = evm.address.toLowerCase();
  if (state.account) return state.account;
  try {
    publish({ setup: 'checking', setupDetail: `switching your wallet to ${namespace.chain_name}` });
    await ensureWalletChain(namespace);
    if (!state.signedIn || state.signedIn.toLowerCase() !== address) {
      publish({ setup: 'signing-in', setupDetail: 'confirm the sign-in message in your wallet' });
      await signIn();
    }
    publish({ setup: 'checking', setupDetail: 'loading proving keys and checking this browser' });
    await ensureParams();
    // 1. Same device: unlock, no prompt. The stored account must belong to
    //    the connected wallet; another wallet gets its own activation.
    if (await LinksAccount.exists(store, namespace.id)) {
      const account = await LinksAccount.unlock(opts(namespace));
      const owner = await account.walletAddress();
      if (owner && owner !== address) {
        publish({ setup: 'idle', setupDetail: `this browser holds the private account of wallet ${shortHex(owner, 6, 4)}; connect that wallet, or clear site data to set up ${shortHex(address, 6, 4)}` });
        return null;
      }
      const v = await account.view();
      if (v.pending) await account.reconcile();
      publish({ account, hasStoredAccount: true, setup: 'ready', setupDetail: null });
      return account;
    }
    // 2. Known to the directory: recover.
    const entry = await client.profile(namespace.id, address);
    if (entry) {
      if (entry.profile.revoked) {
        publish({ setup: 'idle', setupDetail: 'this wallet revoked its private account; set it up again from a wallet you control' });
        return null;
      }
      publish({ recoveryProfile: entry.profile });
      if (entry.profile.recovery === 'wallet-signature') {
        publish({ setup: 'recovery-signature', setupDetail: 'sign the Peal Links recovery message in your wallet to open your backup' });
        const signer = walletSigner(namespace);
        const sig = await signer.signMessage(recoveryMessage(address, namespace.label, namespace.id));
        const backupKey = await deriveBackupKey(sig, address, namespace.id);
        return await finishRecovery(namespace, { mechanism: 'wallet-signature', backupKey });
      }
      publish({ setup: 'needs-recovery-code', setupDetail: 'enter the recovery code you saved when you set up private payments' });
      return null;
    }
    // 3. New: set up. Wallets that sign deterministically get the derived
    //    key; the rest get a recovery code, shown once.
    publish({ setup: 'setting-up', setupDetail: 'checking how your wallet signs (two identical signatures make the recovery key derivable)' });
    const signer = walletSigner(namespace);
    let plan: RecoveryPlan;
    const pc = opts(namespace).publicClient;
    const contract = pc ? await isContractAddress(pc, address).catch(() => false) : false;
    const sig = contract ? null : await deterministicSignature(signer, recoveryMessage(address, namespace.label, namespace.id));
    if (sig) {
      plan = { mechanism: 'wallet-signature', backupKey: await deriveBackupKey(sig, address, namespace.id) };
    } else {
      plan = { mechanism: 'recovery-code', code: newRecoveryCode() };
    }
    publish({ setupDetail: 'confirm the Peal Links account authorization in your wallet' });
    const account = await LinksAccount.setup(opts(namespace), status.circuit_id, signer, shortHex(address, 6, 4), plan);
    publish({
      account,
      hasStoredAccount: true,
      setup: 'ready',
      setupDetail: null,
      newRecoveryCode: plan.mechanism === 'recovery-code' ? plan.code : null,
    });
    return account;
  } catch (e) {
    publish({ setup: 'idle', setupDetail: null });
    throw e;
  }
}

/** The recovery-code path, after `activate` asked for the code. */
export async function recoverWithCode(code: string): Promise<LinksAccount> {
  const { namespace } = state;
  if (!namespace) throw new Error('node status not loaded');
  return finishRecovery(namespace, { mechanism: 'recovery-code', code });
}

async function finishRecovery(namespace: NamespaceInfo, secret: RecoveryPlan): Promise<LinksAccount> {
  publish({ setup: 'checking', setupDetail: 'opening your backup and checking it against the ledger' });
  try {
    const account = await LinksAccount.recover(opts(namespace), secret);
    const profile = state.recoveryProfile;
    if (profile) await store.set(`peal-links:${namespace.id}:profile`, JSON.stringify(profile));
    publish({ account, hasStoredAccount: true, setup: 'ready', setupDetail: null, recoveryProfile: null });
    return account;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no backup is stored/.test(msg)) {
      publish({ setup: 'no-backup', setupDetail: 'this wallet has a Peal Links account but no backup is stored for it; import a backup file if you have one' });
    } else {
      publish({ setup: secret.mechanism === 'recovery-code' ? 'needs-recovery-code' : 'idle', setupDetail: null });
    }
    throw e;
  }
}

/** Import a backup file protected by a recovery code (manual path). */
export async function restoreFile(backupJson: string, code: string): Promise<LinksAccount> {
  const { namespace } = state;
  if (!namespace) throw new Error('node status not loaded');
  await ensureParams();
  const account = await LinksAccount.restoreFile(opts(namespace), backupJson, code);
  await account.register();
  publish({ account, hasStoredAccount: true, setup: 'ready', setupDetail: null });
  return account;
}

// ---- payments with a wallet-approved local intent ---------------------------------

/** Ask the wallet to approve the payment (a local EIP-712 intent, verified
 * here and never transmitted), then prove and pay. */
export async function payRequest(account: LinksAccount, request: PaymentRequest, intentId: string, onStage?: (s: string) => void): Promise<PayResult> {
  const ns = state.namespace!;
  await ensureWalletChain(ns);
  const signer = walletSigner(ns);
  const intent = await account.paymentIntentFor({ request });
  onStage?.('approve');
  const signature = await signer.signTypedData(paymentIntentTypedData(intent, ns.chain_id));
  onStage?.('preparing');
  return account.pay({ request }, intentId, { intent, signature });
}

/** Pay a plain wallet address resolved through the directory. */
export async function payAddress(
  account: LinksAccount,
  address: string,
  amount: string,
  reference: string | null,
  onStage?: (s: string) => void,
): Promise<{ result: PayResult; profile: Profile } | { unregistered: true }> {
  const ns = state.namespace!;
  const resolved = await account.resolve(address);
  if (!resolved) return { unregistered: true };
  await ensureWalletChain(ns);
  const signer = walletSigner(ns);
  const target = { profile: resolved.profile, profileHash: resolved.hash, amount, reference };
  const intent = await account.paymentIntentFor(target);
  onStage?.('approve');
  const signature = await signer.signTypedData(paymentIntentTypedData(intent, ns.chain_id));
  onStage?.('preparing');
  const result = await account.pay(target, newIntentId(), { intent, signature });
  return { result, profile: resolved.profile };
}

/** Rename: a new profile version signed by the wallet. */
export async function rename(account: LinksAccount, displayName: string): Promise<void> {
  const ns = state.namespace!;
  const profile = await account.profile();
  await account.publishProfile(walletSigner(ns), displayName, profile?.recovery ?? 'recovery-code');
  publish({});
}

// ---- sign-in (EIP-4361; API access only, never spending authority) -------------

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
