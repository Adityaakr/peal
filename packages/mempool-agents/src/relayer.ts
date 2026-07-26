// The relayer: the browser's sponsored, no-wallet gateway to the chain.
//
// The visitor signs nothing. The relayer holds a funded key, and on the
// visitor's behalf it submits the public-lane order (in the clear) and the
// peal-lane commitment (a hash). It also serves read endpoints so the browser
// stays a thin fetch client with no chain library of its own: current reserves,
// and the on-chain results of a given order / condition so the page can link
// straight to the block explorer.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  decodeEventLog,
  formatEther,
  parseEther,
  sha256,
  toBytes,
  type Address,
  type Hex,
} from 'viem';
import { erc20Abi, pealMempoolAbi, publicBuilderAbi, swapPoolAbi } from './abi.js';
import { chainFor, loadDeployment, publicClient, requireKey, serializer, waitReceipt, walletFor, writeGas } from './config.js';

const d = loadDeployment();
const pub = publicClient(d);
const wallet = walletFor(d, requireKey('RELAYER_PRIVATE_KEY'));
const relayer = wallet.account.address;
// Railway (and most hosts) inject PORT; fall back to RELAYER_PORT then a default.
const PORT = Number(process.env.PORT ?? process.env.RELAYER_PORT ?? 8799);
// Serialize every relayer send: concurrent visitor requests share one key.
const tx = serializer();

let bootBlock = 0n;

// The RPC caps eth_getLogs at a 100k block range, and this process stays up for
// days, so scanning from bootBlock eventually exceeds it. Every event we look up
// belongs to a swap the visitor started seconds ago, so a trailing window is
// always enough. Never start before bootBlock: results from a previous run of
// the demo are not ours to report.
const LOG_WINDOW = 90_000n;

async function scanFrom(): Promise<bigint> {
  const latest = await pub.getBlockNumber();
  const floor = latest > LOG_WINDOW ? latest - LOG_WINDOW : 0n;
  return floor > bootBlock ? floor : bootBlock;
}

async function ensureApproval(token: Address, spender: Address): Promise<void> {
  const allowance = await pub.readContract({
    address: token, abi: erc20Abi, functionName: 'allowance', args: [relayer, spender],
  });
  if (allowance > 10n ** 30n) return;
  const hash = await tx(() =>
    wallet.writeContract({
      address: token, abi: erc20Abi, functionName: 'approve', args: [spender, 2n ** 256n - 1n],
      chain: chainFor(d), ...writeGas,
    }),
  );
  await waitReceipt(pub, hash);
}

async function reserves(pool: Address): Promise<{ base: string; quote: string }> {
  // Raw wei strings: the browser needs contract-precision reserves to size
  // amountIn/minOut so its quote matches what the pool will actually give.
  const [base, quote] = await Promise.all([
    pub.readContract({ address: pool, abi: swapPoolAbi, functionName: 'reserveBase' }),
    pub.readContract({ address: pool, abi: swapPoolAbi, functionName: 'reserveQuote' }),
  ]);
  return { base: base.toString(), quote: quote.toString() };
}

// ---- handlers -----------------------------------------------------------

async function config() {
  return {
    chainId: d.chainId,
    explorerBase: d.explorerBase,
    // The browser reads the chain itself to verify a reveal (the RPC allows
    // cross-origin reads), so it needs the endpoint, not just our summary of
    // what we found there. A check that trusts this relayer proves nothing.
    rpcUrl: d.rpcUrl,
    relayer,
    usdc: d.usdc,
    eth: d.eth,
    publicPool: d.publicPool,
    publicBuilder: d.publicBuilder,
    pealPool: d.pealPool,
    pealMempool: d.pealMempool,
  };
}

async function state() {
  // Ship the live price and reset target alongside the raw reserves: /prepare
  // rewrites both pools to exactly that state before every swap, so the idle
  // quote card can price against what execution will actually see instead of
  // whatever the last swap left behind.
  const [pubR, pealR, usd] = await Promise.all([
    reserves(d.publicPool),
    reserves(d.pealPool),
    ethUsd(),
  ]);
  return { publicPool: pubR, pealPool: pealR, ethUsd: usd, targetBase: TARGET_BASE.toString() };
}

// Reset target. The USDC-side depth is fixed; the ETH reserve is derived from
// the live ETH/USD price so the pool's implied rate tracks the real market.
// Keeping the USDC depth constant means the sandwich behaviour is identical at
// any price (a searcher sandwiches swaps from ~$5k up). Both lanes are reset to
// exactly this before each swap, so the only difference between them is the
// sandwich, never independent pool drift.
const TARGET_BASE = 900_000n * 10n ** 18n;
const FALLBACK_ETH_USD = 2500;

// Live ETH/USD from CoinGecko, cached 60s. Falls back to the last good value
// (or FALLBACK_ETH_USD) if the fetch fails or is rate-limited, so a swap never
// blocks on the price feed.
let priceCache = { usd: FALLBACK_ETH_USD, at: 0 };
async function ethUsd(): Promise<number> {
  const now = Date.now();
  if (now - priceCache.at < 60_000) return priceCache.usd;
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { signal: AbortSignal.timeout(5000) },
    );
    const j = (await r.json()) as { ethereum?: { usd?: number } };
    const p = j.ethereum?.usd;
    if (typeof p === 'number' && p > 0) priceCache = { usd: p, at: now };
  } catch {
    /* keep the last good price / fallback */
  }
  return priceCache.usd;
}

/** ETH reserve (wad) so that base/quote equals the given price. */
function targetQuote(priceUsd: number): bigint {
  return (TARGET_BASE * 1000n) / BigInt(Math.round(priceUsd * 1000));
}

/** Reset both pools to identical reserves at the live price. Called before each
 * swap so the two lanes start from the same, realistic state. */
async function prepare() {
  const quote = targetQuote(await ethUsd());
  // Submit both pool resets back-to-back (the per-key serializer keeps their
  // nonces in order), then wait for both receipts at once instead of blocking
  // on the first before submitting the second. Halves the reset latency.
  const hashes: `0x${string}`[] = [];
  for (const pool of [d.publicPool, d.pealPool]) {
    hashes.push(
      await tx(() =>
        wallet.writeContract({
          address: pool, abi: swapPoolAbi, functionName: 'adminSetReserves',
          args: [TARGET_BASE, quote], chain: chainFor(d), ...writeGas,
        }),
      ),
    );
  }
  await Promise.all(hashes.map((h) => waitReceipt(pub, h)));
  return { ok: true };
}

/** Submit the public-lane order in the clear, on the visitor's behalf. */
async function publicSwap(body: { amountIn: string; minOut: string; baseToQuote: boolean }) {
  const order = {
    trader: relayer,
    baseToQuote: body.baseToQuote,
    amountIn: parseEther(body.amountIn),
    minOut: parseEther(body.minOut),
    to: relayer,
  };
  const hash = await tx(() =>
    wallet.writeContract({
      address: d.publicBuilder, abi: publicBuilderAbi, functionName: 'submitOrder',
      args: [order], chain: chainFor(d), ...writeGas,
    }),
  );
  await waitReceipt(pub, hash);
  const rcpt = await pub.getTransactionReceipt({ hash });
  let orderId: Hex | null = null;
  for (const log of rcpt.logs) {
    try {
      const ev = decodeEventLog({ abi: publicBuilderAbi, data: log.data, topics: log.topics });
      if (ev.eventName === 'Pending') orderId = (ev.args as { id: Hex }).id;
    } catch {
      /* not a builder event */
    }
  }
  // Without an id there is nothing to poll, and returning null here would only
  // surface later as a lane that never resolves. Fail the submission instead.
  if (!orderId) throw new Error(`submitOrder ${hash} emitted no Pending event`);
  return { txHash: hash, orderId };
}

/** Record the sealed order on the peal lane: only the ciphertext hash. */
async function commit(body: { conditionId: string; ctHash: string }) {
  const cond = sha256(toBytes(body.conditionId));
  const ct = (`0x${body.ctHash.replace(/^0x/, '')}`) as Hex;
  const hash = await tx(() =>
    wallet.writeContract({
      address: d.pealMempool, abi: pealMempoolAbi, functionName: 'commitSealed',
      args: [cond, ct], chain: chainFor(d), ...writeGas,
    }),
  );
  await waitReceipt(pub, hash);
  return { txHash: hash };
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** An orderId is a bytes32. Reject anything else at the edge: viem throws deep
 * inside getContractEvents on a malformed topic, and a 500 there is
 * indistinguishable to the browser from "the searcher has not acted yet". */
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** The public order's fate: sandwiched (with the numbers), honestly filled, or
 * still sitting unincluded in the builder's pending map.
 *
 * That third case has to be distinguishable from "not yet". PublicBuilder
 * defers every order until a builder includes it, so an order no searcher picks
 * up stays pending forever, and a caller that cannot tell the two apart polls
 * forever on a lane that will never resolve. */
async function publicResult(orderId: Hex) {
  const fromBlock = await scanFrom();
  const [sandwiched, executed] = await Promise.all([
    pub.getContractEvents({
      address: d.publicBuilder, abi: publicBuilderAbi, eventName: 'Sandwiched',
      args: { id: orderId }, fromBlock,
    }),
    pub.getContractEvents({
      address: d.publicBuilder, abi: publicBuilderAbi, eventName: 'Executed',
      args: { id: orderId }, fromBlock,
    }),
  ]);
  if (sandwiched.length > 0) {
    const a = sandwiched[0].args as { victimOut: bigint; searcherProfit: bigint };
    return {
      done: true, sandwiched: true,
      victimOut: formatEther(a.victimOut), profit: formatEther(a.searcherProfit),
      txHash: sandwiched[0].transactionHash,
    };
  }
  if (executed.length > 0) {
    const a = executed[0].args as { amountOut: bigint };
    return { done: true, sandwiched: false, victimOut: formatEther(a.amountOut), profit: '0', txHash: executed[0].transactionHash };
  }
  const order = (await pub.readContract({
    address: d.publicBuilder, abi: publicBuilderAbi, functionName: 'pending', args: [orderId],
  })) as readonly [Address, boolean, bigint, bigint, Address];
  return { done: false, pending: order[0] !== ZERO_ADDRESS };
}

/** The sealed order's fate: settled on-chain at reveal, with the fill. */
async function pealResult(conditionId: string) {
  const cond = sha256(toBytes(conditionId));
  const fromBlock = await scanFrom();
  const [batch, fills] = await Promise.all([
    pub.getContractEvents({
      address: d.pealMempool, abi: pealMempoolAbi, eventName: 'BatchExecuted',
      args: { conditionId: cond }, fromBlock,
    }),
    pub.getContractEvents({
      address: d.pealMempool, abi: pealMempoolAbi, eventName: 'OrderFilled',
      args: { conditionId: cond }, fromBlock,
    }),
  ]);
  if (batch.length === 0) return { done: false };
  const a = batch[0].args as { realCount: bigint; merkleRoot: Hex };
  return {
    done: true, realCount: Number(a.realCount), merkleRoot: a.merkleRoot,
    txHash: batch[0].transactionHash,
    fills: fills.map((f) => {
      const fa = f.args as { position: number; amountOut: bigint };
      return { position: fa.position, amountOut: formatEther(fa.amountOut) };
    }),
  };
}

// ---- http plumbing ------------------------------------------------------

function send(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (req.method === 'GET' && url.pathname === '/config') return send(res, 200, await config());
    if (req.method === 'GET' && url.pathname === '/state') return send(res, 200, await state());
    if (req.method === 'GET' && url.pathname === '/public-result') {
      const id = url.searchParams.get('orderId') ?? '';
      if (!BYTES32.test(id)) return send(res, 400, { error: 'orderId must be a bytes32 hex string' });
      return send(res, 200, await publicResult(id as Hex));
    }
    if (req.method === 'GET' && url.pathname === '/peal-result') {
      return send(res, 200, await pealResult(url.searchParams.get('conditionId') ?? ''));
    }
    if (req.method === 'POST' && url.pathname === '/prepare') return send(res, 200, await prepare());
    if (req.method === 'POST' && url.pathname === '/public-swap') return send(res, 200, await publicSwap(await readBody(req)));
    if (req.method === 'POST' && url.pathname === '/commit') return send(res, 200, await commit(await readBody(req)));
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[relayer]', e instanceof Error ? e.message : e);
    send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

async function main(): Promise<void> {
  bootBlock = await pub.getBlockNumber();
  // Sequential: these all send from the relayer key, and firing them together
  // would hand the same nonce to every approval. Approve the POOLS, not the
  // builders: the pool is what calls transferFrom on a trader's tokens.
  await ensureApproval(d.usdc, d.publicPool);
  await ensureApproval(d.eth, d.publicPool);
  await ensureApproval(d.usdc, d.pealPool);
  await ensureApproval(d.eth, d.pealPool);
  server.listen(PORT, () => console.log(`[relayer] ${relayer} listening on :${PORT} (from block ${bootBlock})`));
  // Prime both pools to the live price so a fresh page load shows a realtime
  // rate even before anyone swaps. Best-effort; a failure here is harmless
  // since /prepare runs again before every swap.
  prepare()
    .then(() => console.log(`[relayer] pools primed at $${priceCache.usd}/ETH`))
    .catch((e) => console.error('[relayer] boot prepare failed:', e instanceof Error ? e.message : e));
}

void main();
