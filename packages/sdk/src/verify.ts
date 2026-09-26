// bte-sdk/verify: heavy client-side verification (pairings) in its own wasm
// chunk. Import only where you need it; the root entry stays seal-only.
import initWasm, { Params, verify_share } from './generated/verify/bte_wasm.js';
import WASM_B64 from './generated/verify/wasm-b64.js';
import { b64ToBytes } from './wasm.js';

let ready: Promise<unknown> | null = null;

async function ensureVerifyWasm() {
  if (!ready) {
    ready = initWasm({ module_or_path: b64ToBytes(WASM_B64) });
  }
  await ready;
}

/**
 * Verify one operator's 48-byte share against a frozen batch, entirely
 * client-side: e(pd_j, g_2) == sum_i e(ct_{i,0}, v_j^i).
 *
 * @param paramsB64 committee params blob (GET /v0/committees/:id -> params_b64)
 * @param headersB64 packed B*48-byte header blob for the batch
 * @param shareB64 the operator's BTE_WIRE_V0 share
 */
export async function verifyShare(
  paramsB64: string,
  headersB64: string,
  shareB64: string,
): Promise<boolean> {
  await ensureVerifyWasm();
  const params = new Params(b64ToBytes(paramsB64));
  try {
    return verify_share(params, b64ToBytes(headersB64), b64ToBytes(shareB64));
  } finally {
    params.free();
  }
}
