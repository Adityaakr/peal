// The page side of the prover worker: forwards every call to a worker
// running `serveProver` (from 'peal-links/worker'). No wasm in this module.
import { PROVER_METHODS, type AsyncProver } from './prover.js';

export interface WorkerCall {
  id: number;
  name: keyof typeof PROVER_METHODS;
  args: unknown[];
}

export interface WorkerReply {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export function createRemoteProver(worker: Worker): AsyncProver {
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
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
        worker.postMessage({ id, name, args } satisfies WorkerCall);
      });
  }
  return out as unknown as AsyncProver;
}
