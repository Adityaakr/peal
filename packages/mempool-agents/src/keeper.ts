// The keeper: keeps the demo pools near the live ETH price so repeated swaps
// stay legible. Each demo swap buys ETH, so both pools slowly lose ETH and the
// price creeps up. The keeper tops up the short side (mints to the pool, then
// sync) to restore the target ratio. It only ever adds liquidity, so the pool
// drifts deeper over time but the price stays put — and a $250k swap keeps
// getting sandwiched well past any single demo session.
//
// Largely redundant now that the relayer's /prepare resets both pools to
// identical, live-priced reserves before every swap; it exists as a floor for
// stacks running without it. It must track the SAME live price the relayer
// prepares at: a fixed target here would drag the pools away from that state on
// a 20s timer, and a reserve move landing mid-swap reverts the searcher's
// sandwich (it is sized just under the victim's revert floor).
//
// Uses the deployer key (the DemoToken owner). Purely cosmetic: it touches only
// the demo pools' reserves, nothing in the protocol.
import { formatEther, type Address } from 'viem';
import { demoTokenAbi, swapPoolAbi } from './abi.js';
import { chainFor, loadDeployment, publicClient, requireKey, walletFor, writeGas } from './config.js';

const d = loadDeployment();
const pub = publicClient(d);
const wallet = walletFor(d, requireKey('DEPLOYER_PRIVATE_KEY'));

const FALLBACK_ETH_USD = 2500n; // USDC per ETH, if the price feed is unreachable
const TOLERANCE = 0.02; // reseed when price drifts >2%
const CHECK_MS = 20_000;

/** Live ETH/USD, cached for a tick. Mirrors the relayer's feed so the two
 * services agree on where the pools belong. */
let priceCache = { usd: FALLBACK_ETH_USD, at: 0 };
async function targetPrice(): Promise<bigint> {
  const now = Date.now();
  if (now - priceCache.at < 60_000) return priceCache.usd;
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { signal: AbortSignal.timeout(5000) },
    );
    const j = (await r.json()) as { ethereum?: { usd?: number } };
    const p = j.ethereum?.usd;
    if (typeof p === 'number' && p > 0) priceCache = { usd: BigInt(Math.round(p)), at: now };
  } catch {
    /* keep the last good price / fallback */
  }
  return priceCache.usd;
}

async function reserves(pool: Address): Promise<{ base: bigint; quote: bigint }> {
  const [base, quote] = await Promise.all([
    pub.readContract({ address: pool, abi: swapPoolAbi, functionName: 'reserveBase' }),
    pub.readContract({ address: pool, abi: swapPoolAbi, functionName: 'reserveQuote' }),
  ]);
  return { base: base as bigint, quote: quote as bigint };
}

async function mintTo(token: Address, to: Address, amount: bigint): Promise<void> {
  const hash = await wallet.writeContract({
    address: token, abi: demoTokenAbi, functionName: 'mint', args: [to, amount],
    chain: chainFor(d), ...writeGas,
  });
  await pub.waitForTransactionReceipt({ hash });
}

async function keep(pool: Address, label: string, target: bigint): Promise<void> {
  const { base, quote } = await reserves(pool);
  if (quote === 0n) return;
  const price = Number(base) / Number(quote);
  const drift = Math.abs(price - Number(target)) / Number(target);
  if (drift < TOLERANCE) return;

  // Restore base/quote == target by topping up whichever side is short.
  const targetQuote = base / target;
  if (quote < targetQuote) {
    const add = targetQuote - quote;
    console.log(`[keeper] ${label} at $${price.toFixed(0)}: minting ${formatEther(add)} mETH`);
    await mintTo(d.eth, pool, add);
  } else {
    const add = quote * target - base;
    console.log(`[keeper] ${label} at $${price.toFixed(0)}: minting ${formatEther(add)} mUSDC`);
    await mintTo(d.usdc, pool, add);
  }
  const hash = await wallet.writeContract({
    address: pool, abi: swapPoolAbi, functionName: 'sync', args: [], chain: chainFor(d), ...writeGas,
  });
  await pub.waitForTransactionReceipt({ hash });
  const after = await reserves(pool);
  console.log(`[keeper] ${label} reseeded to $${(Number(after.base) / Number(after.quote)).toFixed(0)}/ETH`);
}

async function tick(): Promise<void> {
  try {
    const target = await targetPrice();
    await keep(d.publicPool, 'public', target);
    await keep(d.pealPool, 'peal', target);
  } catch (e) {
    console.error('[keeper]', e instanceof Error ? e.message : e);
  }
}

async function main(): Promise<void> {
  console.log(`[keeper] ${wallet.account.address} maintaining pools at the live ETH price`);
  await tick();
  setInterval(() => void tick(), CHECK_MS);
}

void main();
