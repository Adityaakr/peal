// An in-thread prover: loads the wasm and answers every call directly.
// Used in Node (tests, scripts) and inside the worker. Not exported from the
// package root, so a page that only talks to the worker does not bundle the
// wasm twice.
import { callProver, PROVER_METHODS, type AsyncProver } from './prover.js';
import { ensureWasm } from './wasm.js';

export async function createLocalProver(): Promise<AsyncProver> {
  const ProverClass = await ensureWasm();
  const prover = new ProverClass();
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const name of Object.keys(PROVER_METHODS) as Array<keyof typeof PROVER_METHODS>) {
    out[name] = async (...args: unknown[]) => callProver(prover, name, args);
  }
  return out as unknown as AsyncProver;
}
