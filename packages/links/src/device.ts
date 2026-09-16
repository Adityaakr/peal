// The device key (decision 0012): a non-extractable WebCrypto AES-GCM key
// that stays in this browser (IndexedDB stores CryptoKey objects by
// structured clone). Everything private the SDK keeps on a device is
// sealed under keys that are themselves sealed under it, so a returning
// visit needs no passphrase and no wallet signature. Losing site data
// loses the device key; recovery then goes through the backup.

export interface DeviceKeys {
  get(): Promise<CryptoKey | null>;
  set(key: CryptoKey): Promise<void>;
}

export class MemoryDeviceKeys implements DeviceKeys {
  private key: CryptoKey | null = null;
  async get() {
    return this.key;
  }
  async set(k: CryptoKey) {
    this.key = k;
  }
}

export function indexedDbDeviceKeys(dbName = 'peal-links-device'): DeviceKeys {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  return {
    async get() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('keys', 'readonly');
        const req = tx.objectStore('keys').get('device');
        req.onsuccess = () => resolve((req.result as CryptoKey | undefined) ?? null);
        req.onerror = () => reject(req.error);
      });
    },
    async set(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('keys', 'readwrite');
        tx.objectStore('keys').put(key, 'device');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };
}

/** The device key, generated on first use: AES-GCM 256, never extractable. */
export async function deviceKey(store: DeviceKeys): Promise<CryptoKey> {
  const existing = await store.get();
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await store.set(key);
  return key;
}

/** A fresh ArrayBuffer for WebCrypto's BufferSource parameters. */
function buf(x: Uint8Array): ArrayBuffer {
  return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) as ArrayBuffer;
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Seal a short secret (hex or JSON) under the device key. */
export async function sealWithDevice(key: CryptoKey, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(new TextEncoder().encode(secret))));
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) });
}

export async function openWithDevice(key: CryptoKey, sealed: string): Promise<string> {
  const { v, iv, ct } = JSON.parse(sealed) as { v: number; iv: string; ct: string };
  if (v !== 1) throw new Error('unsupported device seal');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(unb64(iv)) }, key, buf(unb64(ct)));
  return new TextDecoder().decode(pt);
}
