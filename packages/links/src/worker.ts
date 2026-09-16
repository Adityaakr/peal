// Web Worker side of the prover. The page creates the worker from a module
// that imports this file and talks to it through `createRemoteProver`; the
// wasm never runs on the UI thread, so a seven-second proof leaves the page
// responsive.
//
//   // prover.worker.ts
//   import { serveProver } from 'peal-links/worker';
//   serveProver(self);
//
//   // page
//   const worker = new Worker(new URL('./prover.worker.ts', import.meta.url), { type: 'module' });
//   const prover = createRemoteProver(worker);

import { callProver } from './prover.js';
import type { WorkerCall, WorkerReply } from './remote.js';
import { ensureWasm } from './wasm.js';
import type { Prover } from './generated/peal_links_wasm.js';

export { createRemoteProver } from './remote.js';

/** Install the request handler in a worker scope. */
export function serveProver(scope: { onmessage: ((ev: MessageEvent) => void) | null; postMessage: (m: unknown) => void }): void {
  let proverPromise: Promise<Prover> | null = null;
  const prover = () => {
    if (!proverPromise) proverPromise = ensureWasm().then((P) => new P());
    return proverPromise;
  };
  scope.onmessage = async (ev: MessageEvent<WorkerCall>) => {
    const { id, name, args } = ev.data;
    try {
      const p = await prover();
      const value = callProver(p, name, args);
      scope.postMessage({ id, ok: true, value } satisfies WorkerReply);
    } catch (e) {
      scope.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies WorkerReply);
    }
  };
}
