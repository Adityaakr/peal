// The encrypted mempool, live on a public testnet. A DEX-style swap that, once sent, opens
// into (1) the outcome side-by-side: sandwiched in a public mempool, untouched
// in the sealed Peal mempool, and (2) a technical walk-through of how Peal
// actually did it, populated with the real cryptographic artifacts as they land:
// the ciphertext hash, the t-of-n committee, the verified operator shares, the
// merkle root, and the on-chain verification.
//
// Nothing is simulated: both pools are real contracts, the searcher is a real
// bot, and the sealed order settles via PealMempool.executeBatch. The browser
// signs nothing; the relayer sponsors both lanes. The trust caveat is in the FAQ.
import { BteClient } from 'bte-sdk';
import { API_BASE } from '../api';
import {
  addrUrl,
  commitSealed,
  encodeOrder,
  fromWad,
  getAmountOut,
  getConfig,
  FEE_DEN,
  FEE_NUM,
  getPealResult,
  getPublicResult,
  getState,
  prepareSwap,
  quoteReserves,
  submitPublicSwap,
  toWad,
  txUrl,
  type MempoolConfig,
  type PublicResult,
} from '../mempool/chain';
import {
  createFxBatch,
  createFxCommit,
  createFxEncrypt,
  createFxExposed,
  createFxFrontrun,
  createFxReveal,
  createFxSandwich,
  createSandwichScene,
  createVaultScene,
  type Fx,
  type Scene,
} from '../mempool/visuals';
import { esc, fmtCountdown, truncMiddle } from '../util';

// The cue delay: the order seals to a condition that fires this many seconds
// later, and the whole batch reveals then. Kept short for a snappy demo. The
// floor is the seal reaching the coordinator before the cue (sub-second) plus
// the operator poll (~2s) and the settle tx after reveal, so 5s is safe on a
// fast-finality chain and lands the full swap in ~9-10s.
const ROUND_SECS = 5;
const POLL_MS = 1500;
// How long the public lane waits for a builder to include the order before it
// gives up. PublicBuilder defers every order until someone includes it, so if
// the searcher is down or its bundle reverts, the order sits there forever and
// this lane would otherwise spin on "the searcher is reading your order" while
// the sealed lane has long since settled. Generous enough to cover a slow
// block plus a searcher retry, short enough that nobody is left staring.
const PUBLIC_DEADLINE_MS = 45_000;
const SLIP_BPS: Record<string, bigint> = { '0.001': 10n, '0.005': 50n, '0.01': 100n, '0.03': 300n };

type Sym = 'USDC' | 'ETH';
const COIN: Record<Sym, string> = {
  USDC: '<i class="mp-coin mp-coin-usdc"></i>USDC',
  ETH: '<i class="mp-coin mp-coin-eth"></i>ETH',
};
/** Default pay amount per token, both ~$10k so the two directions are
 * symmetric. The ETH leg used to default to 3 (~$5.6k), which sat close enough
 * to the sandwich threshold that the flagship demo could land on the "too small
 * to sandwich" branch depending on the live price. At the current depth a
 * searcher bites from ~$2.5k up. */
const DEFAULT_AMT: Record<Sym, string> = { USDC: '10000', ETH: '5.3' };

// Cap the demo order so nobody drains the per-swap reset pools with a huge
// trade: ~$100k of either side (USDC 1:1, ETH via the live pool price).
const MAX_SWAP_USD = 100_000;

const usd0 = (n: number) =>
  n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = (n: number) =>
  n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const num = (s: string | number, dp = 4) =>
  Number(s).toLocaleString(undefined, { maximumFractionDigits: dp });

/** Trust-building copy for the four Peal steps. No em-dashes (brand rule). */
const FLOW_COPY = [
  `Your order is encrypted on your own device before it reaches the network. The amount, the direction, and the token stay sealed inside a ciphertext addressed to the committee's key. No relayer, no node, and no operator ever sees it in the clear.`,
  `The ciphertext drops into a fixed batch of 64 slots. The other slots are indistinguishable decoys, so no observer can tell how many real orders are inside, or which slot is yours. Your size, your timing, and your intent disappear into the crowd.`,
  `The power to open your batch is split across a committee of independent operators. Any 3 of the 5 can open it together, and only once the cue fires. No single operator, and no group smaller than the quorum, can read your order early.`,
  `At the cue, a quorum of operators each return one 48-byte share. Together they open the whole batch at once, after the ordering is already fixed, so there is nothing left to front-run. Every share is checked with a public pairing equation, and the settlement contract re-derives the batch's merkle root and rejects any mismatch.`,
];

/** The three moves of a sandwich, on the public lane. */
const PUB_COPY = [
  `On a normal chain your swap waits in the public mempool in plain sight. Anyone watching, including automated searchers, can read the amount, the direction, and the price you are willing to accept, all before it executes.`,
  `Seeing your trade coming, the searcher places its own buy just ahead of yours. That pushes the pool price up, so your swap is now lined up to fill at a worse rate than you were quoted.`,
  `Your swap executes at the price the searcher left behind, and the searcher immediately sells back into it. You receive less than your quote, and that difference, sized to your own slippage limit, becomes the searcher's profit.`,
];

function flowStep(pub: boolean, n: number, chip: string, title: string, copy: string): string {
  const p = pub ? 'p' : '';
  const chipCls = pub ? 'mp-chip-red' : 'mp-chip-blue';
  return `
    <li class="mp-flow-step${pub ? ' mp-flow-pub' : ''}" id="mp-${p}step-${n}">
      <div class="mp-flow-rail"><span class="mp-flow-dot">${n}</span></div>
      <div class="mp-flow-card">
        <div class="mp-flow-viz" id="mp-${p}viz-${n}"></div>
        <div class="mp-flow-text">
          <div class="mp-flow-top"><h4>${esc(title)}</h4><span class="mp-lane-chip ${chipCls}">${esc(chip)}</span></div>
          <p class="mp-flow-copy">${copy}</p>
          <div class="mp-flow-data" id="mp-${p}data-${n}"><div class="mp-lane-status"><span class="mp-spinner"></span>waiting…</div></div>
        </div>
      </div>
    </li>`;
}

export function renderMempool(root: HTMLElement): () => void {
  const previousTitle = document.title;
  document.title = 'Peal Network. encrypted mempool';

  const client = new BteClient({ url: API_BASE });
  let cfg: MempoolConfig | null = null;
  let dead = false;
  let busy = false;
  /** true = pay USDC, receive ETH; false = pay ETH, receive USDC. */
  let usdcToEth = true;
  const timers: number[] = [];
  let sandwich: Scene | null = null;
  let vault: Scene | null = null;
  let fxScenes: Fx[] = [];
  let condId = '';
  let commitTx = '';

  const payToken = (): Sym => (usdcToEth ? 'USDC' : 'ETH');
  const recvToken = (): Sym => (usdcToEth ? 'ETH' : 'USDC');
  const toUsd = (amount: number, sym: Sym, price: number) => (sym === 'USDC' ? amount : amount * price);

  root.innerHTML = `
    <section class="mp">
      <header class="mp-hero">
        <h1 class="mp-title">encrypted mempool</h1>
        <p class="mp-tagline">swap on a live pool. watch MEV vanish, and see exactly how.</p>
      </header>
      <div id="mp-boot" class="mp-boot">connecting to the live pool…</div>
      <div id="mp-app" hidden></div>
    </section>
  `;
  const bootEl = root.querySelector<HTMLElement>('#mp-boot')!;
  const appEl = root.querySelector<HTMLElement>('#mp-app')!;

  void boot();

  async function boot(): Promise<void> {
    try {
      cfg = await getConfig();
      await getState();
      if (dead) return;
      mountApp();
    } catch {
      bootEl.innerHTML = `
        <p class="error" style="margin-top:0">the live demo stack is not reachable.</p>
        <p class="muted">start the relayer, searcher and settler in
        <span class="mono">packages/mempool-agents</span>, then reload.</p>`;
    }
  }

  function mountApp(): void {
    const c = cfg!;
    bootEl.hidden = true;
    appEl.hidden = false;
    appEl.innerHTML = `
      <div class="mp-stage">
        <div class="mp-swap-wrap" id="mp-swap-wrap">
          <div class="mp-swap">
            <div class="mp-swap-head">
              <span>Swap</span>
              <span class="mp-swap-net">Testnet</span>
            </div>
            ${swapField('pay', 'You pay', 'USDC', '10000')}
            <div class="mp-swap-mid">
              <button type="button" class="mp-swap-swapicon" id="mp-flip" aria-label="flip the pair"></button>
            </div>
            ${swapField('recv', 'You receive', 'ETH', '')}
            <div class="mp-swap-info">
              <div class="mp-info-row"><span>Rate</span><span id="mp-rate" class="mono">·</span></div>
              <div class="mp-info-row">
                <span>Max slippage</span>
                <select id="mp-slip" class="mp-slip">
                  <option value="0.001">0.1%</option>
                  <option value="0.005" selected>0.5%</option>
                  <option value="0.01">1%</option>
                  <option value="0.03">3%</option>
                </select>
              </div>
              <div class="mp-info-row"><span>Min received</span><span id="mp-min" class="mono">·</span></div>
              <!-- The difference between what you pay and what you receive is
                   the fee plus the price impact, and nothing else. Showing the
                   two separately is the difference between a quote a visitor
                   can check and an unexplained shortfall. -->
              <div class="mp-info-row"><span>Fee (0.05%)</span><span id="mp-fee" class="mono">·</span></div>
              <div class="mp-info-row"><span>Price impact</span><span id="mp-impact" class="mono">·</span></div>
            </div>
            <button type="button" class="mp-swap-btn" id="mp-go">Swap</button>
            <p class="mp-swap-foot">you sign nothing. the relayer sponsors the transaction.</p>
            <p class="error" id="mp-error" hidden></p>
          </div>
        </div>

        <div class="mp-compare" id="mp-compare" hidden>
          <div class="mp-lanes">
            <article class="mp-lane mp-lane-public">
              <header class="mp-lane-head"><h2>public mempool</h2><span class="mp-lane-chip mp-chip-red">readable</span></header>
              <div class="mp-visual" id="mp-vis-public"></div>
              <div class="mp-lane-result" id="mp-res-public"></div>
            </article>
            <article class="mp-lane mp-lane-peal">
              <header class="mp-lane-head"><h2>peal mempool</h2><span class="mp-lane-chip mp-chip-blue">sealed</span></header>
              <div class="mp-visual" id="mp-vis-peal"></div>
              <div class="mp-lane-result" id="mp-res-peal"></div>
            </article>
          </div>
          <div class="mp-diff" id="mp-diff" hidden></div>

          <section class="mp-flow mp-flow-attack" id="mp-pubflow" hidden>
            <div class="mp-proofs-head">
              <h3>how the public mempool takes your money</h3>
              <p>the same swap in a normal, readable mempool. three moves, and the searcher wins.</p>
            </div>
            <ol class="mp-flow-list">
              ${flowStep(true, 1, 'exposed', 'your order is public', PUB_COPY[0])}
              ${flowStep(true, 2, 'front-run', 'the searcher jumps ahead', PUB_COPY[1])}
              ${flowStep(true, 3, 'sandwiched', 'you fill worse, it takes the spread', PUB_COPY[2])}
            </ol>
          </section>

          <section class="mp-flow" id="mp-proofs" hidden>
            <div class="mp-proofs-head">
              <h3>how Peal keeps your order private</h3>
              <p>four steps, and every value below is a real artifact from your swap, verifiable on-chain.</p>
            </div>
            <ol class="mp-flow-list">
              ${flowStep(false, 1, 'private', 'encrypted on your device', FLOW_COPY[0])}
              ${flowStep(false, 2, 'unlinkable', 'hidden inside a batch', FLOW_COPY[1])}
              ${flowStep(false, 3, 't-of-n', 'sealed to a distributed committee', FLOW_COPY[2])}
              ${flowStep(false, 4, 'verifiable', 'revealed and proven on-chain', FLOW_COPY[3])}
            </ol>
          </section>

          <button type="button" class="btn" id="mp-again" hidden>swap again</button>
        </div>
      </div>

      <section class="mp-faq">
        <h2 class="mp-faq-title">FAQ</h2>
        ${faqHtml(c)}
      </section>
    `;

    wireFaq(appEl);

    const payEl = appEl.querySelector<HTMLInputElement>('#mp-pay')!;
    const slipEl = appEl.querySelector<HTMLSelectElement>('#mp-slip')!;
    const recvEl = appEl.querySelector<HTMLElement>('#mp-recv')!;
    const rateEl = appEl.querySelector<HTMLElement>('#mp-rate')!;
    const minEl = appEl.querySelector<HTMLElement>('#mp-min')!;
    const feeEl = appEl.querySelector<HTMLElement>('#mp-fee')!;
    const impactEl = appEl.querySelector<HTMLElement>('#mp-impact')!;
    const payUsdEl = appEl.querySelector<HTMLElement>('#mp-pay-usd')!;
    const recvUsdEl = appEl.querySelector<HTMLElement>('#mp-recv-usd')!;
    const payTokEl = appEl.querySelector<HTMLElement>('#mp-pay-token')!;
    const recvTokEl = appEl.querySelector<HTMLElement>('#mp-recv-token')!;
    const go = appEl.querySelector<HTMLButtonElement>('#mp-go')!;

    const refreshQuote = async () => {
      if (busy) return;
      try {
        // Quote against the post-reset reserves (live price), not the stale
        // pool state left by the last swap: /prepare re-prices both lanes
        // before execution, so this is what the visitor will actually get.
        const pool = quoteReserves(await getState());
        const [rIn, rOut] = usdcToEth ? [pool.base, pool.quote] : [pool.quote, pool.base];
        const amountIn = toWad(Number(payEl.value) || 0);
        const out = getAmountOut(amountIn, rIn, rOut);
        const slip = SLIP_BPS[slipEl.value] ?? 50n;
        const floor = (out * (10000n - slip)) / 10000n;
        const price = Number(fromWad(pool.base)) / Number(fromWad(pool.quote));
        recvEl.textContent = num(fromWad(out));
        rateEl.textContent = `1 ETH = ${num(price, 2)} USDC`;
        minEl.textContent = `${num(fromWad(floor))} ${recvToken()}`;
        const payUsd = toUsd(Number(payEl.value) || 0, payToken(), price);
        payUsdEl.textContent = usd0(payUsd);
        const recvUsd = toUsd(Number(fromWad(out)), recvToken(), price);
        recvUsdEl.textContent = usd0(recvUsd);
        // Account for the pay/receive difference exactly. The fee is a flat cut
        // of the input; whatever is left of the shortfall is price impact, i.e.
        // the pool moving under your own order. Deriving impact as the residual
        // rather than modelling it separately means the two rows always add up
        // to the number on screen, even at the wei rounding.
        const feeUsd = payUsd * (Number(FEE_DEN - FEE_NUM) / Number(FEE_DEN));
        const impactUsd = Math.max(0, payUsd - recvUsd - feeUsd);
        feeEl.textContent = usd2(feeUsd);
        impactEl.textContent = payUsd > 0 ? `${((100 * impactUsd) / payUsd).toFixed(3)}%` : '·';
        // Enforce the demo cap: over ~$100k, block the swap and say why.
        const over = payUsd > MAX_SWAP_USD;
        go.disabled = over;
        go.textContent = over ? 'max $100,000 per swap' : 'Swap';
      } catch {
        /* transient */
      }
    };
    payEl.addEventListener('input', () => void refreshQuote());
    slipEl.addEventListener('change', () => void refreshQuote());
    void refreshQuote();

    const flip = () => {
      if (busy) return;
      usdcToEth = !usdcToEth;
      payTokEl.innerHTML = COIN[payToken()];
      recvTokEl.innerHTML = COIN[recvToken()];
      payEl.value = DEFAULT_AMT[payToken()];
      void refreshQuote();
    };
    appEl.querySelector<HTMLButtonElement>('#mp-flip')!.addEventListener('click', flip);
    // Clicking either token pill flips too, like a token selector.
    payTokEl.addEventListener('click', flip);
    recvTokEl.addEventListener('click', flip);

    go.addEventListener('click', () => {
      if (busy) return;
      void run(Number(payEl.value) || 0, slipEl.value).catch((err) => showError(err));
    });

    appEl.querySelector<HTMLButtonElement>('#mp-again')!.addEventListener('click', () => reset());
  }

  function showError(err: unknown): void {
    const el = appEl.querySelector<HTMLElement>('#mp-error');
    if (el) {
      el.hidden = false;
      el.textContent = err instanceof Error ? err.message : String(err);
    }
    busy = false;
    const go = appEl.querySelector<HTMLButtonElement>('#mp-go');
    if (go) {
      go.disabled = false;
      go.textContent = 'Swap';
    }
  }

  function reset(): void {
    const compare = appEl.querySelector<HTMLElement>('#mp-compare')!;
    const swapWrap = appEl.querySelector<HTMLElement>('#mp-swap-wrap')!;
    compare.classList.remove('is-in');
    compare.hidden = true;
    appEl.querySelector<HTMLElement>('#mp-diff')!.hidden = true;
    appEl.querySelector<HTMLElement>('#mp-pubflow')!.hidden = true;
    appEl.querySelector<HTMLElement>('#mp-proofs')!.hidden = true;
    appEl.querySelector<HTMLButtonElement>('#mp-again')!.hidden = true;
    swapWrap.hidden = false;
    void swapWrap.offsetWidth;
    swapWrap.classList.remove('is-out');
    sandwich?.destroy();
    vault?.destroy();
    fxScenes.forEach((fx) => fx.destroy());
    sandwich = null;
    vault = null;
    fxScenes = [];
    busy = false;
    const go = appEl.querySelector<HTMLButtonElement>('#mp-go');
    if (go) {
      go.disabled = false;
      go.textContent = 'Swap';
    }
  }

  // ---- the run ----------------------------------------------------------

  async function run(amount: number, slipKey: string): Promise<void> {
    busy = true;
    const c = cfg!;
    const go = appEl.querySelector<HTMLButtonElement>('#mp-go')!;
    go.disabled = true;
    go.textContent = 'sending…';

    const baseToQuote = usdcToEth;
    const recvUnit = recvToken();
    const payUnit = payToken();
    const amountIn = toWad(amount);

    // Transition immediately so the click feels instant. The on-chain pool
    // reset then runs while the comparison view is already animating, instead
    // of holding the button on "sending…" for the whole reset.
    const swapWrap = appEl.querySelector<HTMLElement>('#mp-swap-wrap')!;
    const compare = appEl.querySelector<HTMLElement>('#mp-compare')!;
    swapWrap.classList.add('is-out');
    setTimeout(() => {
      swapWrap.hidden = true;
    }, 420);
    compare.hidden = false;
    void compare.offsetWidth;
    compare.classList.add('is-in');

    sandwich = createSandwichScene();
    vault = createVaultScene();
    appEl.querySelector<HTMLElement>('#mp-vis-public')!.appendChild(sandwich.el);
    appEl.querySelector<HTMLElement>('#mp-vis-peal')!.appendChild(vault.el);
    sandwich.play();
    vault.play();
    // The flow animations loop continuously so the process is always visible.
    fxScenes = [createFxEncrypt(), createFxBatch(), createFxCommit(), createFxReveal()];
    fxScenes.forEach((fx, i) => appEl.querySelector<HTMLElement>(`#mp-viz-${i + 1}`)!.appendChild(fx.el));

    // Public-lane attack pipeline: the first two moves are known immediately.
    const pubFx = [createFxExposed(), createFxFrontrun(), createFxSandwich()];
    pubFx.forEach((fx, i) => appEl.querySelector<HTMLElement>(`#mp-pviz-${i + 1}`)!.appendChild(fx.el));
    fxScenes.push(...pubFx);
    appEl.querySelector<HTMLElement>('#mp-pubflow')!.hidden = false;

    const publicRes = appEl.querySelector<HTMLElement>('#mp-res-public')!;
    const pealRes = appEl.querySelector<HTMLElement>('#mp-res-peal')!;
    publicRes.innerHTML = laneStatus('preparing the pool…');
    pealRes.innerHTML = laneStatus('preparing the pool…');

    // Reset both lanes to identical reserves, so the only difference between
    // them is the sandwich, never independent pool drift. If it fails, roll the
    // swap card back rather than stranding the comparison view.
    try {
      await prepareSwap();
    } catch (e) {
      reset();
      showError(e);
      return;
    }
    if (dead) return;

    const { pealPool } = await getState();
    const [rIn, rOut] = usdcToEth ? [pealPool.base, pealPool.quote] : [pealPool.quote, pealPool.base];
    const fair = getAmountOut(amountIn, rIn, rOut);
    const slip = SLIP_BPS[slipKey] ?? 50n;
    const minOut = (fair * (10000n - slip)) / 10000n;
    const midPrice = Number(fromWad(pealPool.base)) / Number(fromWad(pealPool.quote));

    fillPub12(amount, payUnit, recvUnit, fromWad(minOut));
    publicRes.innerHTML = laneStatus('the searcher is reading your order in the clear…');
    pealRes.innerHTML = laneStatus(`sealed · cue in ${ROUND_SECS}s · searcher sees only a hash`);

    // The committee is known before we even seal; fill step 1's threshold.
    const committee = await client.committee();

    const conditionId = await client.condition({ in: ROUND_SECS, tag: 'mempool' });
    condId = conditionId;
    const payload = encodeOrder({ trader: c.relayer, baseToQuote, amountIn, minOut, to: c.relayer });
    const sealed = await client.seal(payload, conditionId);
    if (dead) return;

    // Steps 1-3 are known the moment the order is sealed.
    appEl.querySelector<HTMLElement>('#mp-proofs')!.hidden = false;
    fillStep1(sealed.ctHash);
    fillStep2(committee, null);
    fillStep3(committee, '');

    const commit = await commitSealed(conditionId, sealed.ctHash);
    commitTx = commit.txHash;
    fillStep3(committee, commitTx);
    pealRes.innerHTML = laneStatus(
      `committed on-chain · ${link(commit.txHash)} · cue in ${ROUND_SECS}s`,
    );

    const pub = await submitPublicSwap({
      amountIn: String(amount),
      minOut: fromWad(minOut),
      baseToQuote,
    });

    const [pubOut, pealOut] = await Promise.all([
      pollPublic(pub.orderId, fair, { recvUnit, payUnit, price: midPrice, submitTx: pub.txHash }, publicRes),
      pollPeal(conditionId, fair, recvUnit, pealRes, committee),
    ]);
    if (dead) return;

    // Difference banner.
    const diff = appEl.querySelector<HTMLElement>('#mp-diff')!;
    diff.hidden = false;
    // Both lanes started from identical reserves (prepareSwap), so peal is never
    // worse than public; clamp to guard against wei rounding.
    const keptUsd = Math.max(0, toUsd(Number(pealOut.fill) - Number(pubOut.victimOut), recvUnit, midPrice));
    if (pubOut.stalled) {
      // There is no comparison to draw: the public lane produced no fill. Own
      // that plainly rather than counting a missing fill as money saved.
      diff.innerHTML =
        `<span class="mp-diff-kicker">the sealed lane settled. the public lane did not.</span>` +
        `<span class="mp-diff-cap">your order opened on Peal and filled on-chain, but no builder ever included the public copy, so there is no public fill to compare against. that is a gap in this live demo's own searcher, not a claim about either mempool. swap again to retry.</span>`;
    } else if (pubOut.sandwiched && keptUsd > 0.01) {
      diff.innerHTML =
        `<span class="mp-diff-kicker">same swap, two mempools</span>` +
        `<span class="mp-diff-num">${usd2(keptUsd)}</span>` +
        `<span class="mp-diff-cap">kept on Peal that the searcher took in the public mempool</span>`;
    } else {
      diff.innerHTML =
        `<span class="mp-diff-kicker">same swap, two mempools</span>` +
        `<span class="mp-diff-cap">this trade was too small to sandwich, so both lanes filled the same. raise the amount and the public lane starts leaking, while the sealed lane never does.</span>`;
    }
    appEl.querySelector<HTMLButtonElement>('#mp-again')!.hidden = false;
    busy = false;
  }

  // ---- public attack pipeline (3 moves of a sandwich) -------------------

  function fillPub12(amount: number, payUnit: Sym, recvUnit: Sym, minOut: string): void {
    const pd = (n: number) => appEl.querySelector<HTMLElement>(`#mp-pdata-${n}`)!;
    const done = (n: number) => appEl.querySelector<HTMLElement>(`#mp-pstep-${n}`)?.classList.add('is-done');
    pd(1).innerHTML =
      proofRow('you swap', `<b>${num(amount, payUnit === 'USDC' ? 0 : 4)}</b> ${payUnit} to ${recvUnit}`) +
      proofRow('you accept as low as', `${num(minOut, recvUnit === 'USDC' ? 2 : 4)} ${recvUnit}`) +
      proofRow('the searcher sees', `<span class="mp-danger">all of it</span>`);
    done(1);
    pd(2).innerHTML =
      proofRow('front-run', `placed just ahead of your swap`) +
      proofRow('effect', `<span class="mp-danger">price pushed against you</span>`);
    done(2);
  }

  function fillPub3(
    sandwiched: boolean,
    victimOut: string,
    fair: string,
    profitUsd: number,
    recvUnit: Sym,
    txHash: string,
  ): void {
    const dp = recvUnit === 'USDC' ? 2 : 4;
    const body = appEl.querySelector<HTMLElement>('#mp-pdata-3')!;
    body.innerHTML = sandwiched
      ? proofRow('you received', `<span class="mp-danger"><b>${num(victimOut, dp)}</b> ${recvUnit}</span>`) +
        proofRow('you were quoted', `${num(fair, dp)} ${recvUnit}`) +
        proofRow('the searcher took', `<span class="mp-danger"><b>${usd2(profitUsd)}</b></span>`) +
        proofRow('on-chain', `${link(txHash)}`)
      : proofRow('you received', `${num(victimOut, dp)} ${recvUnit}, in full`) +
        proofRow('the searcher took', `nothing, too small to sandwich`) +
        proofRow('on-chain', `${link(txHash)}`);
    appEl.querySelector<HTMLElement>('#mp-pstep-3')?.classList.add('is-done');
  }

  /** Step 3 when no builder ever included the order. The demo's whole claim is
   * that nothing here is simulated, so say what actually happened rather than
   * inventing a fill or blaming the mempool for a bot that was not running. */
  function fillPubStalled(submitTx: string): void {
    appEl.querySelector<HTMLElement>('#mp-pdata-3')!.innerHTML =
      proofRow('you received', `<span class="mp-danger">nothing yet</span>`) +
      proofRow('why', `no builder included your order`) +
      proofRow('still readable', `<span class="mp-danger">sitting in the mempool, in the clear</span>`) +
      (submitTx ? proofRow('submitted', `${link(submitTx)}`) : '');
    appEl.querySelector<HTMLElement>('#mp-pstep-3')?.classList.add('is-done');
  }

  /** The public lane's result when it never settled. */
  function stalledHtml(stillPending: boolean, submitTx: string): string {
    const why = stillPending
      ? `no builder included your order. it is still sitting in the public mempool, readable by anyone.`
      : `the public lane never reported a fill.`;
    return `
      <div class="mp-result-num mp-got-ok">&mdash;</div>
      <div class="mp-result-line">${why} ${submitTx ? link(submitTx) : ''}</div>`;
  }

  // ---- the 4 Peal pipeline steps (real BTE artifacts) -------------------

  function stepData(n: number): HTMLElement {
    return appEl.querySelector<HTMLElement>(`#mp-data-${n}`)!;
  }
  function markDone(n: number): void {
    appEl.querySelector<HTMLElement>(`#mp-step-${n}`)?.classList.add('is-done');
  }

  /** Step 1: encrypted on the device. */
  function fillStep1(ctHash: string): void {
    stepData(1).innerHTML =
      proofRow('ciphertext', `<span class="mono">${esc(truncMiddle(ctHash, 8, 8))}</span>`) +
      proofRow('the searcher sees', `<span class="mp-danger">nothing readable</span>`);
    markDone(1);
  }

  /** Step 2: hidden inside a padded batch. */
  function fillStep2(
    committee: { b: number },
    batch: { real: number; total: number } | null,
  ): void {
    const batchRow = batch
      ? proofRow('this batch', `<b>${batch.real}</b> real + <b>${batch.total - batch.real}</b> decoys = ${batch.total} slots`)
      : proofRow('batch', `${committee.b} fixed slots, decoys included`);
    stepData(2).innerHTML =
      batchRow + proofRow('your slot', `indistinguishable from the rest`);
    markDone(2);
  }

  /** Step 3: sealed to a t-of-n committee, committed on-chain. */
  function fillStep3(
    committee: { n: number; t: number; digest: string },
    txHash: string,
  ): void {
    stepData(3).innerHTML =
      proofRow('committee', `${operatorPips(committee.n, committee.t)} any <b>${committee.t}</b> of <b>${committee.n}</b>`) +
      proofRow('params digest', `<span class="mono">${esc(truncMiddle(committee.digest, 8, 6))}</span>`) +
      (txHash ? proofRow('committed', `${link(txHash)}`) : proofRow('committed', 'submitting…'));
    if (txHash) markDone(3);
  }

  /** Step 4: revealed by a quorum and proven on-chain. */
  function fillStep4(
    reveal: { merkleRoot: string; shares: Array<{ verified: boolean }>; slots: Array<{ isDummy: boolean }> },
    committee: { n: number },
    txHash: string,
  ): void {
    const verified = reveal.shares.filter((s) => s.verified).length;
    const real = reveal.slots.filter((s) => !s.isDummy).length;
    const verifyLink = condId
      ? `<a class="mp-proc-verify" href="#/condition/${encodeURIComponent(condId)}">
           verify the full batch, every slot, share and timing
           <span class="mp-proc-arrow" aria-hidden="true"></span></a>`
      : '';
    stepData(4).innerHTML =
      proofRow('shares', `${checks(verified, committee.n)} <b>${verified}</b> of ${committee.n} verified`) +
      proofRow('batch opened', `${real} real order${real === 1 ? '' : 's'}, together`) +
      proofRow('merkle root', `<span class="mono">${esc(truncMiddle(reveal.merkleRoot, 8, 6))}</span>`) +
      proofRow('settled', `executeBatch ${link(txHash)}`) +
      verifyLink;
    markDone(4);
  }

  // ---- lane polling / rendering -----------------------------------------

  // msg is trusted HTML built from developer templates (it may embed a link());
  // callers escape their own dynamic plain-text parts, so do not escape here.
  // Wrap it in one span so the flex row is just spinner + text: the message then
  // flows and wraps as normal inline text instead of each run becoming its own
  // flex item.
  function laneStatus(msg: string): string {
    return `<div class="mp-lane-status"><span class="mp-spinner" aria-hidden="true"></span><span class="mp-lane-msg">${msg}</span></div>`;
  }

  function link(hash: string): string {
    const u = txUrl(cfg!, hash);
    const short = `${hash.slice(0, 8)}…${hash.slice(-4)}`;
    return u
      ? `<a class="mono link" href="${u}" target="_blank" rel="noopener">${short}</a>`
      : `<span class="mono">${short}</span>`;
  }

  interface PubOut {
    sandwiched: boolean;
    victimOut: string;
    profit: string;
    /** No builder ever included the order: this lane produced no fill at all. */
    stalled?: boolean;
  }

  function pollPublic(
    orderId: string,
    fairWei: bigint,
    ctx: { recvUnit: Sym; payUnit: Sym; price: number; submitTx: string },
    resEl: HTMLElement,
  ): Promise<PubOut> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let fails = 0;
      const tick = async () => {
        if (dead) return resolve({ sandwiched: false, victimOut: fromWad(fairWei), profit: '0' });
        let r: PublicResult;
        try {
          r = await getPublicResult(orderId);
          fails = 0;
        } catch {
          // Do not swallow this silently forever: a relayer that has stopped
          // answering looks exactly like a searcher that has not acted yet, and
          // the lane would keep showing a caption that is no longer true.
          r = { done: false };
          if (++fails === 3) resEl.innerHTML = laneStatus('the relayer stopped answering. retrying…');
        }
        if (!r.done) {
          if (Date.now() - startedAt < PUBLIC_DEADLINE_MS) return;
          // Deadline. The sealed lane settled long ago; end the comparison
          // honestly instead of spinning on a lane that will never resolve.
          clearInterval(id);
          sandwich?.resolve({ stalled: true });
          resEl.innerHTML = stalledHtml(r.pending !== false, ctx.submitTx);
          fillPubStalled(ctx.submitTx);
          return resolve({ sandwiched: false, victimOut: '0', profit: '0', stalled: true });
        }
        clearInterval(id);
        const fair = Number(fromWad(fairWei));
        if (r.sandwiched) {
          // One figure everywhere: the shortfall from the fair quote, i.e. what
          // the sandwich cost the victim. The 3D scene, this status line, the
          // proof row, and the peal-vs-public headline all use it, so the demo
          // never shows two different "the searcher took" numbers.
          const lostUsd = toUsd(fair - Number(r.victimOut), ctx.recvUnit, ctx.price);
          sandwich?.resolve({ lostUsd });
          resEl.innerHTML = resultHtml({
            tone: 'bad',
            got: r.victimOut ?? '',
            unit: ctx.recvUnit,
            line: `the searcher took <b>${usd2(lostUsd)}</b>`,
            tx: link(r.txHash ?? ''),
          });
          fillPub3(true, r.victimOut ?? '', fromWad(fairWei), lostUsd, ctx.recvUnit, r.txHash ?? '');
        } else {
          sandwich?.resolve({ lostUsd: 0 });
          resEl.innerHTML = resultHtml({
            tone: 'ok',
            got: r.victimOut ?? '',
            unit: ctx.recvUnit,
            line: `filled in full, too small to sandwich`,
            tx: link(r.txHash ?? ''),
          });
          fillPub3(false, r.victimOut ?? '', fromWad(fairWei), 0, ctx.recvUnit, r.txHash ?? '');
        }
        resolve({ sandwiched: !!r.sandwiched, victimOut: r.victimOut ?? fromWad(fairWei), profit: r.profit ?? '0' });
      };
      const id = window.setInterval(() => void tick(), POLL_MS);
      timers.push(id);
      void tick();
    });
  }

  interface PealOut {
    fill: string;
  }

  function pollPeal(
    conditionId: string,
    fairWei: bigint,
    recvUnit: Sym,
    resEl: HTMLElement,
    committee: { n: number; t: number; b: number; digest: string },
  ): Promise<PealOut> {
    return new Promise((resolve) => {
      let firesAt = Math.floor(Date.now() / 1000) + ROUND_SECS;
      const tick = async () => {
        if (dead) return resolve({ fill: fromWad(fairWei) });
        try {
          const st = await client.status(conditionId);
          if (st.firesAt) firesAt = st.firesAt;
          // Live batch fill: how many real orders are queued with yours.
          if (st.ciphertextCount) {
            fillStep2(committee, { real: st.realCount, total: committee.b });
          }
        } catch {
          /* transient */
        }
        const secs = firesAt - Math.floor(Date.now() / 1000);
        const r = await getPealResult(conditionId).catch(() => ({ done: false }) as never);
        if (!r.done) {
          resEl.innerHTML = laneStatus(
            secs > 0
              ? `sealed. the batch opens in ${esc(fmtCountdown(secs))}. nothing to read.`
              : `the cue fired. opening the batch on-chain…`,
          );
          return;
        }
        clearInterval(id);
        const fill = r.fills?.[0]?.amountOut ?? fromWad(fairWei);
        vault?.resolve({ kept: true });
        resEl.innerHTML = resultHtml({
          tone: 'good',
          got: fill,
          unit: recvUnit,
          line: `the searcher took <b>$0</b>, opened by executeBatch`,
          tx: link(r.txHash ?? ''),
        });
        // Proof step 3: the real reveal (shares, root, on-chain verification).
        try {
          const reveal = await client.reveal(conditionId);
          if (reveal) fillStep4(reveal, committee, r.txHash ?? '');
        } catch {
          /* the lane result already shows the settlement tx */
        }
        resolve({ fill });
      };
      const id = window.setInterval(() => void tick(), POLL_MS);
      timers.push(id);
      void tick();
    });
  }

  function resultHtml(o: { tone: 'bad' | 'ok' | 'good'; got: string; unit: Sym; line: string; tx: string }): string {
    const gotClass = o.tone === 'bad' ? 'mp-got-bad' : o.tone === 'good' ? 'mp-got-good' : 'mp-got-ok';
    const dp = o.unit === 'USDC' ? 2 : 4;
    const coin = COIN[o.unit];
    return `
      <div class="mp-result-num ${gotClass}">${num(o.got, dp)}<span class="mp-result-coin">${coin}</span></div>
      <div class="mp-result-line">${o.line}. ${o.tx}</div>`;
  }

  return () => {
    dead = true;
    for (const t of timers) clearInterval(t);
    sandwich?.destroy();
    vault?.destroy();
    fxScenes.forEach((fx) => fx.destroy());
    document.title = previousTitle;
  };
}

// ---- small html builders ------------------------------------------------

function swapField(id: 'pay' | 'recv', label: string, sym: Sym, value: string): string {
  const input =
    id === 'pay'
      ? `<input type="number" id="mp-pay" value="${value}" min="0.0001" max="50000000" step="10000" autocomplete="off" inputmode="decimal" />`
      : `<span class="mp-recv" id="mp-recv">0.0</span>`;
  return `
    <div class="mp-swap-field">
      <div class="mp-field-top"><span>${label}</span></div>
      <div class="mp-field-main">
        ${input}
        <button type="button" class="mp-token" id="mp-${id}-token">${COIN[sym]}<span class="mp-token-caret"></span></button>
      </div>
      <div class="mp-field-bot">
        <span class="mp-usd" id="mp-${id}-usd">$0</span>
        <span class="mp-chain">on testnet</span>
      </div>
    </div>`;
}

function proofRow(k: string, v: string): string {
  return `<div class="mp-proof-row"><span class="mp-proof-k">${k}</span><span class="mp-proof-v">${v}</span></div>`;
}

/** n operator dots, the first t highlighted as "any t can open". */
function operatorPips(n: number, t: number): string {
  let s = '<span class="mp-pips">';
  for (let i = 0; i < n; i++) s += `<span class="mp-pip${i < t ? ' mp-pip-on' : ''}"></span>`;
  return s + `</span>`;
}

function checks(n: number, total: number): string {
  let s = '<span class="mp-checks">';
  for (let i = 0; i < total; i++) s += `<span class="mp-check${i < n ? ' mp-check-on' : ''}"></span>`;
  return s + '</span>';
}

// ---- FAQ ----------------------------------------------------------------

function faqHtml(cfg: MempoolConfig): string {
  const items: Array<[string, string]> = [
    [
      'Is any of this simulated?',
      `No. Both pools are real contracts on chain ${cfg.chainId}. The searcher is a real bot with its own key; on the public lane it submits real front-run and back-run transactions, and on the peal lane it sees only a ciphertext hash and does nothing. Your order is sealed through the real committee and settled by <span class="mono">PealMempool.executeBatch</span>, which re-derives the batch's merkle root and refuses anything that is not the revealed batch.`,
    ],
    [
      'How can I verify it myself?',
      `Everything is on-chain. The transaction links above open the block explorer. The contracts:` +
        contractsList(cfg),
    ],
    [
      'Do I need a wallet or gas?',
      `No. You sign nothing. A relayer holds a funded key and sponsors both submissions on your behalf, so you can try it with one click.`,
    ],
    [
      'How does the searcher take money on the public side?',
      `It reads your pending swap in the clear, buys ahead of you to push the price up (the front-run), lets your swap fill at the worse price, then sells back (the back-run). It sizes the front-run to push you to exactly your slippage floor and no further, so your tolerance is really the quote you hand the searcher.`,
    ],
    [
      'How does the sealing actually work?',
      `Batched threshold encryption. Your order is encrypted to a committee's public key so only a t-of-n quorum of operators can open it, and only on the cue. Crucially the committee's per-open work is independent of the batch size, so one 48-byte share from each operator opens a whole batch of orders at once. Nothing is readable before the cue, not by the searcher, and not by any single operator.`,
    ],
    [
      'Why can the searcher not do that on the peal side?',
      `Because it never sees the order. The commitment on-chain is just a hash: no amount, no direction, nothing to wrap a sandwich around. The whole batch opens at once at the cue, after the ordering is already fixed.`,
    ],
    [
      "What's the honest gap today?",
      `The committee is dealer-trusted and its operators do not yet verify the cue for themselves, so today a dishonest operator could read the sealed order early. That is the decentralisation work still on the roadmap. The cryptography and the settlement are real; the committee's trust model is not there yet.`,
    ],
  ];
  return items
    .map(
      ([q, a], i) => `
      <div class="mp-faq-item" data-faq="${i}">
        <button type="button" class="mp-faq-q" aria-expanded="false">
          <span>${esc(q)}</span><span class="mp-faq-caret" aria-hidden="true"></span>
        </button>
        <div class="mp-faq-a"><div class="mp-faq-inner">${a}</div></div>
      </div>`,
    )
    .join('');
}

function contractsList(cfg: MempoolConfig): string {
  const rows: Array<[string, string]> = [
    ['PealMempool (settles the sealed batch)', cfg.pealMempool],
    ['PublicBuilder (the unprotected lane)', cfg.publicBuilder],
    ['Peal pool', cfg.pealPool],
    ['Public pool', cfg.publicPool],
    ['mUSDC', cfg.usdc],
    ['mETH', cfg.eth],
  ];
  const li = rows
    .map(([name, addr]) => {
      const u = addrUrl(cfg, addr);
      const a = u
        ? `<a class="mono link" href="${u}" target="_blank" rel="noopener">${esc(truncMiddle(addr, 8, 6))}</a>`
        : `<span class="mono">${esc(truncMiddle(addr, 8, 6))}</span>`;
      return `<li><span>${esc(name)}</span>${a}</li>`;
    })
    .join('');
  return `<ul class="mp-contracts">${li}</ul>`;
}

function wireFaq(scope: HTMLElement): void {
  scope.querySelectorAll<HTMLButtonElement>('.mp-faq-q').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.mp-faq-item')!;
      const open = item.classList.toggle('is-open');
      btn.setAttribute('aria-expanded', String(open));
    });
  });
}
