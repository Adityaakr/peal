// The wallet wasm module, inlined as base64 with lazy async init. Works in a
// browser, a Web Worker and Node (vitest) without bundler configuration.
import initWasm, { Prover } from './generated/peal_links_wasm.js';
import WASM_B64 from './generated/wasm-b64.js';

export function b64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let ready: Promise<unknown> | null = null;

/** Idempotent lazy init. Returns the `Prover` class. */
export async function ensureWasm(): Promise<typeof Prover> {
  if (!ready) ready = initWasm({ module_or_path: b64ToBytes(WASM_B64) });
  await ready;
  return Prover;
}

export type { Prover };
