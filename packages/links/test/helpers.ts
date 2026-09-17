// Shared by the SDK tests: a signed-in node client for an EVM wallet, and
// the one-wallet account setup (decisions 0011 and 0012) driven by a viem
// local account standing in for a browser wallet.
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  deriveBackupKey,
  deterministicSignature,
  LinksAccount,
  localSigner,
  MemoryDeviceKeys,
  MemoryStore,
  newRecoveryCode,
  NodeClient,
  recoveryMessage,
  siweMessage,
  type AsyncProver,
  type NamespaceInfo,
  type RecoveryPlan,
  type WalletSigner,
  type WalletStore,
} from '../src/index.js';

export const URL_ = process.env.LINKS_URL ?? 'http://127.0.0.1:8790';

/** anvil's well-known test keys; never real funds. */
export const ANVIL_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
] as const;

export function evmAccount(i: number): PrivateKeyAccount {
  return privateKeyToAccount(ANVIL_KEYS[i]!);
}

/** A node client signed in (EIP-4361) as `account`. */
export async function signedClient(account: PrivateKeyAccount, chainId: number): Promise<NodeClient> {
  const client = new NodeClient({ baseUrl: URL_ });
  const { nonce } = await client.nonce();
  const message = siweMessage({ domain: 'localhost:5173', address: account.address, uri: 'http://localhost:5173/bonsai/app', chainId, nonce });
  await client.session(message, await account.signMessage({ message }));
  return client;
}

export interface Device {
  store: WalletStore;
  deviceKeys: MemoryDeviceKeys;
}

export function device(): Device {
  return { store: new MemoryStore(), deviceKeys: new MemoryDeviceKeys() };
}

/** The recovery plan a browser would prepare: the derived key when the
 * wallet signs deterministically (viem local accounts do), else a code. */
export async function recoveryPlan(signer: WalletSigner, ns: NamespaceInfo, mechanism: 'wallet-signature' | 'recovery-code'): Promise<RecoveryPlan> {
  if (mechanism === 'recovery-code') return { mechanism, code: newRecoveryCode() };
  const sig = await deterministicSignature(signer, recoveryMessage(signer.address, ns.label, ns.id));
  if (!sig) throw new Error('test wallet signs non-deterministically');
  return { mechanism, backupKey: await deriveBackupKey(sig, signer.address, ns.id) };
}

export async function setupAccount(
  prover: AsyncProver,
  ns: NamespaceInfo,
  circuitId: string,
  evm: PrivateKeyAccount,
  displayName: string,
  mechanism: 'wallet-signature' | 'recovery-code',
  dev: Device = device(),
): Promise<{ account: LinksAccount; client: NodeClient; signer: WalletSigner; recovery: RecoveryPlan; dev: Device }> {
  const client = await signedClient(evm, ns.chain_id);
  const signer = localSigner(evm, ns.chain_id);
  const recovery = await recoveryPlan(signer, ns, mechanism);
  const account = await LinksAccount.setup({ prover, client, namespace: ns.id, store: dev.store, deviceKeys: dev.deviceKeys }, circuitId, signer, displayName, recovery);
  return { account, client, signer, recovery, dev };
}
