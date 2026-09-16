// Web Worker side of the prover. The page creates the worker from this
// module and talks to it through `createRemoteProver`; the wasm never runs
// on the UI thread, so a twenty-second proof leaves the page responsive.
//
//   const worker = new Worker(new URL('peal-links/worker', import.meta.url), { type: 'module' });
//   const prover = createRemoteProver(worker);

import { callProver, PROVER_METHODS, type AsyncProver } from './prover.js';
import { ensureWasm } from './wasm.js';
import type { Prover } from './generated/peal_links_wasm.js';

interface Call {
  id: number;
  name: keyof typeof PROVER_METHODS;
  args: unknown[];
}

interface Reply {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Install the request handler in a worker scope. */
export function serveProver(scope: { onmessage: ((ev: MessageEvent) => void) | null; postMessage: (m: unknown) => void }): void {
  let proverPromise: Promise<Prover> | null = null;
  const prover = () => {
    if (!proverPromise) proverPromise = ensureWasm().then((P) => new P());
    return proverPromise;
  };
  scope.onmessage = async (ev: MessageEvent<Call>) => {
    const { id, name, args } = ev.data;
    try {
      const p = await prover();
      const value = callProver(p, name, args);
      scope.postMessage({ id, ok: true, value } satisfies Reply);
    } catch (e) {
      scope.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies Reply);
    }
  };
}

/** A prover that forwards every call to a worker running `serveProver`. */
export function createRemoteProver(worker: Worker): AsyncProver {
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  worker.onmessage = (ev: MessageEvent<Reply>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.ok) p.resolve(ev.data.value);
    else p.reject(new Error(ev.data.error ?? 'prover error'));
  };
  worker.onerror = (ev) => {
    for (const p of pending.values()) p.reject(new Error(ev.message || 'prover worker failed'));
    pending.clear();
  };
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const name of Object.keys(PROVER_METHODS) as Array<keyof typeof PROVER_METHODS>) {
    out[name] = (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, name, args } satisfies Call);
      });
  }
  return out as unknown as AsyncProver;
}

// When loaded as a worker entry, serve immediately.
declare const self: unknown;
if (typeof self !== 'undefined' && typeof (self as { importScripts?: unknown }).importScripts === 'function') {
  serveProver(self as { onmessage: ((ev: MessageEvent) => void) | null; postMessage: (m: unknown) => void });
}
