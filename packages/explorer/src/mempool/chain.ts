// Browser-side client for the live encrypted-mempool demo.
//
// Talks to the relayer (sponsored, no wallet) for on-chain writes and reads,
// and encodes the sealed order the exact way PealMempool.executeBatch decodes
// it. The order rides through the real coordinator sealed, so the payload here
// is what the committee opens and what the contract settles.

// Strip a trailing slash so VITE_RELAYER_URL="https://host/" does not produce
// double-slash "https://host//config" requests.
const RELAYER = (import.meta.env.VITE_RELAYER_URL ?? 'http://localhost:8799').replace(/\/+$/, '');

export interface MempoolConfig {
  chainId: number;
  explorerBase: string;
  /** Public RPC. The browser reads the chain directly through this to verify a
   * reveal, so no claim on the condition page rests on the relayer's word. */
  rpcUrl: string;
  relayer: `0x${string}`;
  usdc: `0x${string}`;
  eth: `0x${string}`;
  publicPool: `0x${string}`;
  publicBuilder: `0x${string}`;
  pealPool: `0x${string}`;
  pealMempool: `0x${string}`;
}

/** Explorer address URL, or null when no explorer is configured. */
export function addrUrl(cfg: MempoolConfig, addr: string): string | null {
  if (!cfg.explorerBase) return null;
  return `${cfg.explorerBase.replace(/\/$/, '')}/address/${addr}`;
}

export interface PoolState {
  /** Reserves in wei. */
  base: bigint;
  quote: bigint;
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${RELAYER}${path}`, init);
  if (!res.ok) throw new Error(`relayer ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export function getConfig(): Promise<MempoolConfig> {
  return j<MempoolConfig>('/config');
}

export interface MempoolState {
  publicPool: PoolState;
  pealPool: PoolState;
  /** Live ETH/USD from the relayer's price feed. Older relayers omit it. */
  ethUsd?: number;
  /** USDC-side depth (wei) the relayer resets both pools to before a swap. */
  targetBase?: bigint;
}

export async function getState(): Promise<MempoolState> {
  const raw = await j<{
    publicPool: { base: string; quote: string };
    pealPool: { base: string; quote: string };
    ethUsd?: number;
    targetBase?: string;
  }>('/state');
  const p = (s: { base: string; quote: string }) => ({ base: BigInt(s.base), quote: BigInt(s.quote) });
  return {
    publicPool: p(raw.publicPool),
    pealPool: p(raw.pealPool),
    ethUsd: raw.ethUsd,
    targetBase: raw.targetBase ? BigInt(raw.targetBase) : undefined,
  };
}

/** The reserves a swap will actually execute against: /prepare resets both
 * pools to the target depth at the live price before every swap, so quote
 * against that state, not the last swap's leftovers. Falls back to the peal
 * pool's current reserves when the relayer predates the live-price field.
 * The quote derivation mirrors the relayer's targetQuote() exactly. */
export function quoteReserves(st: MempoolState): PoolState {
  if (st.ethUsd && st.ethUsd > 0 && st.targetBase) {
    return {
      base: st.targetBase,
      quote: (st.targetBase * 1000n) / BigInt(Math.round(st.ethUsd * 1000)),
    };
  }
  return st.pealPool;
}

/** Reset both pools to identical reserves before a swap, so the only difference
 * between the lanes is the sandwich. */
export function prepareSwap(): Promise<{ ok: boolean }> {
  return j('/prepare', { method: 'POST' });
}

export function commitSealed(conditionId: string, ctHash: string): Promise<{ txHash: string }> {
  return j('/commit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conditionId, ctHash }),
  });
}

export function submitPublicSwap(body: {
  amountIn: string;
  minOut: string;
  baseToQuote: boolean;
}): Promise<{ txHash: string; orderId: `0x${string}` }> {
  return j('/public-swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export interface PublicResult {
  done: boolean;
  /** Only meaningful while `done` is false: the order is on the builder's book
   * and still waiting for someone to include it. Older relayers omit it. */
  pending?: boolean;
  sandwiched?: boolean;
  victimOut?: string;
  profit?: string;
  txHash?: string;
}

export function getPublicResult(orderId: string): Promise<PublicResult> {
  return j<PublicResult>(`/public-result?orderId=${orderId}`);
}

export interface PealResult {
  done: boolean;
  realCount?: number;
  merkleRoot?: string;
  txHash?: string;
  fills?: Array<{ position: number; amountOut: string }>;
}

export function getPealResult(conditionId: string): Promise<PealResult> {
  return j<PealResult>(`/peal-result?conditionId=${encodeURIComponent(conditionId)}`);
}

// ---- amounts, at contract precision ------------------------------------

const FEE_NUM = 997n;
const FEE_DEN = 1000n;

/** Matches SwapPool.getAmountOut exactly. */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n) return 0n;
  const inWithFee = amountIn * FEE_NUM;
  return (reserveOut * inWithFee) / (reserveIn * FEE_DEN + inWithFee);
}

const WAD = 10n ** 18n;

export function toWad(whole: number): bigint {
  // Parse a human decimal to wei without floating error for typical inputs.
  const [int, frac = ''] = String(whole).split('.');
  const fracPadded = (frac + '0'.repeat(18)).slice(0, 18);
  return BigInt(int || '0') * WAD + BigInt(fracPadded || '0');
}

export function fromWad(wei: bigint, dp = 4): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / WAD;
  const frac = (abs % WAD).toString().padStart(18, '0').slice(0, dp);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** The swap order, abi-encoded to the 160 bytes the contract decodes. */
export function encodeOrder(o: {
  trader: `0x${string}`;
  baseToQuote: boolean;
  amountIn: bigint;
  minOut: bigint;
  to: `0x${string}`;
}): Uint8Array {
  const out = new Uint8Array(160);
  const addr = (hex: string, wordStart: number) => {
    const bytes = hexToBytes(hex);
    out.set(bytes, wordStart + 32 - 20);
  };
  const uint = (x: bigint, wordStart: number) => {
    let v = x;
    for (let i = 31; i >= 0; i--) {
      out[wordStart + i] = Number(v & 0xffn);
      v >>= 8n;
    }
  };
  addr(o.trader, 0);
  out[63] = o.baseToQuote ? 1 : 0;
  uint(o.amountIn, 64);
  uint(o.minOut, 96);
  addr(o.to, 128);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, '');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function txUrl(cfg: MempoolConfig, hash: string): string | null {
  if (!cfg.explorerBase) return null;
  return `${cfg.explorerBase.replace(/\/$/, '')}/tx/${hash}`;
}
