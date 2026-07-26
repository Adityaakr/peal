// The searcher: a real bot with its own key.
//
// On the PUBLIC lane it reads each pending order in the clear, sizes a sandwich
// to the victim's slippage floor, and if it is profitable submits real
// front-run and back-run transactions that extract value. If a swap is too
// small to beat the fee, it includes it honestly instead (the victim still gets
// filled). It is the block builder for that lane.
//
// On the PEAL lane it sees only Sealed(conditionId, ctHash) — a hash — so there
// is nothing to size and nothing to wrap. It logs that it is giving up. That
// failure is the demo: same bot, same intent, blind because the order is sealed.
import { formatEther, type Address, type Hex } from 'viem';
import { erc20Abi, pealMempoolAbi, publicBuilderAbi, swapPoolAbi } from './abi.js';
import { chainFor, loadDeployment, publicClient, requireKey, serializer, walletFor, writeGas } from './config.js';
import { planSandwich, type Reserves } from './sandwich.js';

const d = loadDeployment();
const pub = publicClient(d);
const wallet = walletFor(d, requireKey('SEARCHER_PRIVATE_KEY'));
const searcher = wallet.account.address;
const tx = serializer();

// The searcher is the public lane's only builder: PublicBuilder defers every
// order until someone includes it, so an order this process drops sits in
// `pending` forever and the visitor's public lane never produces a result. The
// sweep below is the backstop for that, and the RPC caps eth_getLogs at a 100k
// block range, so it looks back over a trailing window.
const LOG_WINDOW = 90_000n;
const SWEEP_MS = 5_000;

async function reserves(): Promise<Reserves> {
  const [base, quote] = await Promise.all([
    pub.readContract({ address: d.publicPool, abi: swapPoolAbi, functionName: 'reserveBase' }),
    pub.readContract({ address: d.publicPool, abi: swapPoolAbi, functionName: 'reserveQuote' }),
  ]);
  return { base, quote };
}

async function ensureApproval(token: Address): Promise<void> {
  const allowance = await pub.readContract({
    address: token, abi: erc20Abi, functionName: 'allowance', args: [searcher, d.publicPool],
  });
  if (allowance > 10n ** 30n) return;
  const hash = await wallet.writeContract({
    address: token, abi: erc20Abi, functionName: 'approve', args: [d.publicPool, 2n ** 256n - 1n],
    chain: chainFor(d), ...writeGas,
  });
  await pub.waitForTransactionReceipt({ hash });
}

/** Orders with an inclusion attempt in flight right now. An id is held only for
 * the duration of the attempt, never permanently: a failed attempt releases it
 * so the sweep can retry. Marking an id handled up front and keeping it there
 * is what strands an order when a single attempt fails. */
const inFlight = new Set<string>();

async function isExecuted(id: Hex): Promise<boolean> {
  return (await pub.readContract({
    address: d.publicBuilder, abi: publicBuilderAbi, functionName: 'executed', args: [id],
  })) as boolean;
}

/** Send a write and report whether it actually succeeded.
 *
 * TX_GAS is set on chains whose eth_estimateGas under-provisions (see config),
 * and an explicit gas limit means viem never estimates, so a call that reverts
 * is mined with a failed receipt instead of throwing at submission. Treating
 * that as success is how a reverted sandwich silently leaves the order pending. */
async function sendWrite(
  label: string,
  send: () => Promise<Hex>,
): Promise<{ ok: boolean; hash: Hex; reason?: string }> {
  const hash = await tx(send);
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (rcpt.status !== 'success') {
    return { ok: false, hash, reason: `${label} reverted on-chain in ${hash}` };
  }
  return { ok: true, hash };
}

/** Include the order honestly: the victim fills as submitted, nobody profits.
 * This is both the "too small to sandwich" path and the fallback when a
 * sandwich fails, because leaving the order pending is never acceptable. */
async function executeHonestly(id: Hex): Promise<void> {
  const r = await sendWrite('execute', () =>
    wallet.writeContract({
      address: d.publicBuilder, abi: publicBuilderAbi, functionName: 'execute',
      args: [id], chain: chainFor(d), ...writeGas,
    }),
  );
  // Throw rather than swallow: `include` releases the id and the sweep retries.
  if (!r.ok) throw new Error(r.reason);
  console.log(`[searcher] INCLUDED ${id.slice(0, 10)} honestly in ${r.hash}`);
}

async function include(
  id: Hex,
  baseToQuote: boolean,
  amountIn: bigint,
  minOut: bigint,
): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    // The chain, not a local set, is the source of truth for "already done":
    // this process may have restarted, and the sweep re-offers old orders.
    if (await isExecuted(id)) return;

    const r = await reserves();
    const plan = planSandwich(r, baseToQuote, amountIn, minOut);

    if (plan.worthIt) {
      console.log(
        `[searcher] pending ${id.slice(0, 10)} readable: ${formatEther(amountIn)} in, ` +
          `front-run ${formatEther(plan.frontIn)}, expected profit ${formatEther(plan.profit)}`,
      );
      // The bundle is atomic and sized just under the victim's revert floor, so
      // a reserve move between the plan and inclusion kills it, and a searcher
      // out of inventory cannot front-run at all. Neither is a reason to
      // abandon the victim: on any failure, fall through and include honestly.
      let failure: string | null = null;
      try {
        const r = await sendWrite('sandwich', () =>
          wallet.writeContract({
            address: d.publicBuilder, abi: publicBuilderAbi, functionName: 'sandwich',
            args: [id, plan.frontIn], chain: chainFor(d), ...writeGas,
          }),
        );
        if (r.ok) {
          console.log(`[searcher] SANDWICHED ${id.slice(0, 10)} in ${r.hash}`);
          return;
        }
        failure = r.reason ?? 'sandwich failed';
      } catch (e) {
        failure = (e instanceof Error ? e.message : String(e)).split('\n')[0];
      }
      console.warn(`[searcher] sandwich on ${id.slice(0, 10)} failed (${failure}); including honestly`);
      // The receipt wait can time out on a transaction that later lands, so
      // re-read the chain before sending a second inclusion for the same order.
      if (await isExecuted(id)) return;
    } else {
      console.log(
        `[searcher] pending ${id.slice(0, 10)} readable but not worth it ` +
          `(${formatEther(amountIn)} in) — including honestly`,
      );
    }
    await executeHonestly(id);
  } finally {
    inFlight.delete(id);
  }
}

interface PendingArgs {
  id: Hex;
  baseToQuote: boolean;
  amountIn: bigint;
  minOut: bigint;
}

/** Every order the live watcher did not carry to completion: one submitted
 * while this process was down, one whose log the watcher missed, and one whose
 * inclusion attempt failed. Without this, a single dropped order leaves the
 * visitor's public lane spinning forever while the sealed lane settles. */
async function sweep(): Promise<void> {
  const latest = await pub.getBlockNumber();
  const fromBlock = latest > LOG_WINDOW ? latest - LOG_WINDOW : 0n;
  const logs = await pub.getContractEvents({
    address: d.publicBuilder, abi: publicBuilderAbi, eventName: 'Pending', fromBlock,
  });
  for (const log of logs) {
    const a = log.args as PendingArgs;
    if (inFlight.has(a.id)) continue;
    if (await isExecuted(a.id)) continue;
    console.log(`[searcher] sweep: ${a.id.slice(0, 10)} still unincluded, picking it up`);
    await include(a.id, a.baseToQuote, a.amountIn, a.minOut).catch((e) =>
      console.error(`[searcher] sweep failed on ${a.id.slice(0, 10)}:`, e instanceof Error ? e.message : e),
    );
  }
}

async function main(): Promise<void> {
  console.log(`[searcher] ${searcher} watching public lane ${d.publicBuilder}`);
  // Sequential: both approvals send from the searcher key.
  await ensureApproval(d.usdc);
  await ensureApproval(d.eth);

  pub.watchContractEvent({
    address: d.publicBuilder, abi: publicBuilderAbi, eventName: 'Pending', poll: true, pollingInterval: 1000,
    onLogs: (logs) => {
      for (const log of logs) {
        const a = log.args as PendingArgs;
        void include(a.id, a.baseToQuote, a.amountIn, a.minOut).catch((e) =>
          // Not the last word: the sweep retries anything still pending.
          console.error(`[searcher] failed on ${a.id}:`, e instanceof Error ? e.message : e),
        );
      }
    },
  });

  // The blind lane: prove the bot sees only a hash and does nothing with it.
  pub.watchContractEvent({
    address: d.pealMempool, abi: pealMempoolAbi, eventName: 'Sealed', poll: true, pollingInterval: 1000,
    onLogs: (logs) => {
      for (const log of logs) {
        const a = log.args as { ctHash: `0x${string}` };
        console.log(
          `[searcher] sealed order ${a.ctHash.slice(0, 12)} on the peal lane — ` +
            `only a hash, no amount or direction. nothing to sandwich. giving up.`,
        );
      }
    },
  });

  // Catch up on anything already waiting, then keep sweeping alongside the
  // watcher so no order is ever left sitting in the builder's pending map.
  await sweep().catch((e) => console.error('[searcher] boot sweep:', e instanceof Error ? e.message : e));
  setInterval(() => {
    void sweep().catch((e) => console.error('[searcher] sweep:', e instanceof Error ? e.message : e));
  }, SWEEP_MS);
}

void main();
