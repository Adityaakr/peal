// Browser storage for encrypted wallet state: one IndexedDB object store,
// string keys and string values. Everything written here is ciphertext (the
// wallet under the storage key, the storage key under the passphrase) or a
// cursor; nothing readable about the account.

import type { WalletStore } from './account.js';

export function indexedDbStore(dbName = 'peal-links'): WalletStore {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    });
  const run = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('kv', mode);
        const req = fn(tx.objectStore('kv'));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
      });
    } finally {
      db.close();
    }
  };
  return {
    async get(k) {
      const v = await run<string | undefined>('readonly', (s) => s.get(k) as IDBRequest<string | undefined>);
      return v ?? null;
    },
    async set(k, v) {
      await run('readwrite', (s) => s.put(v, k));
    },
    async delete(k) {
      await run('readwrite', (s) => s.delete(k));
    },
  };
}

/** Cache parameter files by digest so a 15 MB proving key downloads once. */
export async function cachedParamFile(
  store: WalletStore,
  name: string,
  digest: string,
  fetchFile: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const k = `peal-links:params:${name}:${digest}`;
  const hit = await store.get(k);
  if (hit) return b64ToBytes(hit);
  const bytes = await fetchFile();
  try {
    await store.set(k, bytesToB64(bytes));
  } catch {
    /* quota: run without the cache */
  }
  return bytes;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}
