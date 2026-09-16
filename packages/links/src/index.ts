// peal-links: the Peal Links SDK.
//
// Layers, from the wire up:
// - `NodeClient`: the node's HTTP API (status, params, ledger, auth,
//   requests, inbox, deposits).
// - `AsyncProver`: the wasm wallet (proving, envelopes, backups), in a
//   worker (`createRemoteProver`) or in-thread (`createLocalProver` from
//   'peal-links/local', Node and tests).
// - `LinksAccount`: one private account with crash-safe flows.
//
// Privacy consequences worth knowing before use: the node sees which account
// submits which operation and when, request titles and amounts you publish,
// and encrypted inbox traffic. It never sees an opening, a balance or a key.
// Deposits and withdrawals are public on the backing chain.

export * from './client.js';
export * from './prover.js';
export * from './remote.js';
export * from './account.js';
export * from './storage.js';
export * from './chain.js';
export * from './typed.js';
export * from './device.js';
export * from './recovery.js';

import { NodeClient } from './client.js';
import type { AsyncProver, KeyInfo } from './prover.js';
import type { WalletStore } from './account.js';
import { cachedParamFile } from './storage.js';

/** Download (or read from cache) the four parameter files by digest and
 * load them into the prover, checking the circuit id the node reports. */
export async function loadParams(client: NodeClient, prover: AsyncProver, store?: WalletStore): Promise<KeyInfo> {
  const index = await client.params();
  const get = async (name: string): Promise<Uint8Array> => {
    const entry = index.files[name];
    if (!entry) throw new Error(`node does not serve ${name}`);
    const fetchFile = () => client.paramFile(name, entry.digest);
    return store ? cachedParamFile(store, name, entry.digest, fetchFile) : fetchFile();
  };
  const [opPk, opVk, depPk, depVk] = await Promise.all([get('op.pk'), get('op.vk'), get('deposit.pk'), get('deposit.vk')]);
  return prover.loadKeys(opPk, opVk, depPk, depVk, index.circuit_id);
}

/** Random payer intent id for checkout reservations and idempotency. */
export function newIntentId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
