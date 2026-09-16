// Recovery material (decision 0012): a backup key derived from a
// deterministic wallet signature, or a user-held recovery code. Neither
// the signature nor the code is ever sent anywhere; the derived key lives
// in memory and, on a device, sealed under the device key.

import type { Hex, PublicClient } from 'viem';
import type { WalletSigner } from './typed.js';

const enc = new TextEncoder();

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function buf(x: Uint8Array): ArrayBuffer {
  return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) as ArrayBuffer;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** HKDF-SHA256 over the signature bytes, salted and bound to the wallet and
 * the ledger namespace: 32 bytes, hex. */
export async function deriveBackupKey(signature: Hex, address: string, namespaceId: string): Promise<string> {
  const ikm = await crypto.subtle.importKey('raw', buf(hexToBytes(signature)), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: buf(enc.encode('peal-links/v1/backup-key')),
      info: buf(enc.encode(`${address.toLowerCase()}|${namespaceId.toLowerCase()}`)),
    },
    ikm,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

/** Sign the recovery message twice; the signature is returned only if the
 * wallet signs deterministically (the two are identical). */
export async function deterministicSignature(signer: WalletSigner, message: string): Promise<Hex | null> {
  const a = await signer.signMessage(message);
  const b = await signer.signMessage(message);
  return a.toLowerCase() === b.toLowerCase() ? a : null;
}

/** Whether an address holds code on the chain (a contract wallet). */
export async function isContractAddress(publicClient: PublicClient, address: string): Promise<boolean> {
  const code = await publicClient.getCode({ address: address as `0x${string}` });
  return !!code && code !== '0x';
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I

/** A user-held recovery code: `PEAL-` plus 20 symbols from a 32-symbol
 * alphabet (100 bits), grouped for reading. */
export function newRecoveryCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(20));
  const s = Array.from(b, (x) => CODE_ALPHABET[x % 32]).join('');
  return `PEAL-${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}`;
}

/** Canonical form of a typed recovery code, or null if it is not one. */
export function normalizeRecoveryCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = s.startsWith('PEAL') ? s.slice(4) : s;
  if (body.length !== 20 || [...body].some((c) => !CODE_ALPHABET.includes(c))) return null;
  return `PEAL-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15, 20)}`;
}
