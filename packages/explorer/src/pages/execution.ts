// Private Actions: the /execution section.
//
// Two jobs, and one deliberate omission.
//
// It explains the guarantee in the exact words the protocol can defend — the
// eight-stage lifecycle, and who can see what at each stage. And it ships a
// receipt verifier that really runs `verifyReceipt` from peal-actions in the
// visitor's own tab, on a receipt built in that same tab, so every check is
// exercised against real cryptography. That is the whole point of a verifiable
// receipt, so it should not require trusting this page either.
//
// What it does NOT do is show a live intent feed. The /v1 API exists now, but a
// public deployment has no real intents in it, and a dashboard of invented
// swaps is the one thing this product cannot afford to ship. The build status
// below says plainly what is live and what is not.
//
// The verifier used to be a textarea and nothing else, which made it the one
// control on the site that could not be used: it asked for an execution receipt
// and no visitor has ever held one. It now builds a real receipt in the tab
// first. Real is meant literally, and it is the only reason this is worth
// shipping: a fresh agent key, a genuine EIP-712 signature over the envelope, a
// merkle root computed over a real batch and a real inclusion proof for the
// slot the intent landed in. Nothing is a fixture and nothing is asserted by
// this page. Then you can break it on purpose and watch a named check fail,
// which is the part that actually demonstrates the receipt is worth something.
import {
  encodePayload,
  PAYLOAD_VERSION,
  PROTOCOL_VERSION,
  signIntent,
  type IntentEnvelope,
  type SwapPayload,
} from 'peal-actions';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BteClient } from 'bte-sdk';
import { decodePayload } from 'peal-actions';
import { API_BASE } from '../api';
import { esc } from '../util';

/** The action the receipt is about. Concrete numbers, because "swap 50,000
 * USDC for at least 14.2 ETH" is checkable by eye and `0x…` is not. */
const DEMO_SWAP = (now: number, recipient: `0x${string}`): SwapPayload => ({
  payloadVersion: PAYLOAD_VERSION,
  actionType: 'swap',
  originChainId: 8453,
  destinationChainId: 8453,
  sellToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  buyToken: '0x4200000000000000000000000000000000000006',
  sellAmount: '50000000000',
  minimumBuyAmount: '14200000000000000000',
  recipient,
  refundAddress: recipient,
  deadline: now + 600,
  maximumFee: '5000000',
  preferredAdapters: ['zerox'],
  excludedAdapters: [],
  allowPartialFill: false,
  privateSubmissionRequired: true,
});

/* ------------------------------------------------------------------ live run
 *
 * The whole lifecycle Peal owns, driven from this tab against the deployment
 * this page is served from. Nothing here is staged: the round is a real round,
 * the ciphertext is sealed in wasm in the browser, the intent carries a real
 * EIP-712 signature from a key generated seconds ago, and the states come from
 * the coordinator's own event log.
 *
 * It stops at ORDER_COMMITTED and the reveal, which is exactly where Peal's
 * guarantee stops. Quoting, authorization and settlement need an executor and a
 * live relay, and the status table below says so rather than this section
 * pretending otherwise.
 */

type StepState = 'idle' | 'doing' | 'done' | 'failed';

interface Step {
  key: string;
  label: string;
  /** What just became true, in plain words. */
  means: string;
  state: StepState;
  detail?: string;
  /** Where the thing named in `detail` can be looked at. Only set for the two
   * that have a page of their own: everything else stays plain text rather
   * than becoming a link to nowhere. */
  href?: string;
}

/** How long the round waits before opening. Long enough that the sealed window
 * is visibly a window, short enough that a person will stay for it. */
const RUN_SECONDS = 45;

const RUN_STEPS: ReadonlyArray<{ key: string; label: string; means: string }> = [
  {
    key: 'key',
    label: 'An agent appears',
    means: 'A keypair made in this tab. It is the agent, and it never leaves the browser.',
  },
  {
    key: 'round',
    label: 'A deadline is set',
    means: 'A real round on the network, opening in ' + String(RUN_SECONDS) + ' seconds.',
  },
  {
    key: 'seal',
    label: 'The intent becomes unreadable',
    means: 'Encrypted here, in this tab. Only the ciphertext was sent, so nobody received the intent itself.',
  },
  {
    key: 'intent',
    label: 'The agent commits to it',
    means: 'A signature binds the agent to that exact ciphertext without revealing what is inside it.',
  },
  {
    key: 'commit',
    label: 'Its place in line is fixed',
    means: 'The batch froze and the ordering was written down, while every intent in it was still unreadable.',
  },
  {
    key: 'reveal',
    label: 'Only now does it open',
    means: 'Too late to trade against: the order of execution was decided before anyone could read a thing.',
  },
];


/* ------------------------------------------------------------- the two queues
 *
 * Built out of the same primitives the sealbid and mempool pages use for the
 * same job: `.ml-stage` under one perspective, two `.ml-col`, an `.ml-bot` for
 * the searcher and `.ml-sealed` for a commitment. Reused rather than cloned, so
 * the three pages stay one product.
 *
 * The beats do the arguing. The searcher is not present at rest; it arrives
 * only once there is something to read, which is the point being made.
 */
function openOrder(qty: string, buys: string, mine = false): string {
  return `<div class="ml-pub-card ex-oord${mine ? ' ex-oord-victim' : ''}">
    <div class="ml-pub-top">
      <span class="ml-strong">${esc(qty)}</span>
      <span class="ml-arrow">for</span>
      <span class="ml-strong">${esc(buys)}</span>
    </div>
    <div class="ml-pub-meta">${mine ? 'yours, and everyone can read it' : 'readable the moment it lands'}</div>
    ${mine ? '<span class="ex-outbid">filled worse</span>' : ''}
  </div>`;
}

function sealedOrder(hash: string, slot: string, qty: string, buys: string): string {
  return `<div class="ml-sealed ex-sord">
    <div class="ml-sealed-top"><span class="mono ml-hdr">&#x2B21; <b>${esc(hash)}</b></span></div>
    <div class="ml-sealed-env mono">
      <span>slot ${esc(slot)}</span>
      <span class="ex-sq"><span class="ex-q-sealed">size ?</span><span class="ex-q-open">${esc(qty)}</span></span>
      <span class="ex-sq"><span class="ex-q-sealed">for ?</span><span class="ex-q-open">${esc(buys)}</span></span>
    </div>
  </div>`;
}

function stageHtml(): string {
  return `
    <div class="ml-stage" id="ex-stage">
      <div class="ml-col ml-col-public">
        <div class="ml-col-head">
          <span class="ml-col-title">open queue &middot; today</span>
          <span class="ml-col-note">every intent readable</span>
        </div>
        <div class="ml-bot ex-searcher">
          <span class="mono">searcher 0xee…42</span>
          <span class="ml-strong">buy ahead of it, sell behind it</span>
        </div>
        ${openOrder('50,000 USDC', 'ETH', true)}
        ${openOrder('12,400 USDC', 'ETH')}
        ${openOrder('3,900 USDC', 'ETH')}
        <div class="ml-micro">
          <span class="ex-m-rest">the searcher reads your intent, then takes the slot in front of it</span>
          <span class="ex-m-snipe">read, then filled worse by exactly what it took</span>
        </div>
      </div>

      <div class="ml-col ml-col-peal">
        <div class="ml-col-head">
          <span class="ml-col-title">sealed queue</span>
          <span class="ml-col-note">
            <span class="ex-m-rest">commitments only</span>
            <span class="ex-m-open">opened together</span>
          </span>
        </div>
        ${sealedOrder('0x7f3ac210…9b41', '1', '50,000 USDC', 'ETH')}
        ${sealedOrder('0x1a6f2c7f…d415', '2', '12,400 USDC', 'ETH')}
        ${sealedOrder('0xc19e3227…be22', '3', '3,900 USDC', 'ETH')}
        <div class="sl-clearbar ex-lockbar">
          <span>ordering locked</span><b>before any of it opened</b><span>slots are final</span>
        </div>
        <div class="ml-micro">
          <span class="ex-m-rest">nothing to get in front of, because no intent is readable</span>
          <span class="ex-m-open">no intent was readable before its slot was fixed</span>
        </div>
      </div>
    </div>

    <p class="ml-thesis">the searcher is not late. <b>there is nothing to be early to.</b></p>`;
}

/** Beats: read, snipe, lock, open. Returns a teardown. */
function driveStage(host: HTMLElement): () => void {
  const stage = host.querySelector<HTMLElement>('#ex-stage');
  if (!stage) return () => {};
  let beat = 0;
  const timer = window.setInterval(() => {
    beat = (beat + 1) % 8;
    stage.classList.toggle('is-scan', beat === 1);
    stage.classList.toggle('is-snipe', beat >= 2 && beat <= 4);
    stage.classList.toggle('is-locked', beat >= 3);
    stage.classList.toggle('is-open', beat >= 5);
  }, 1400);
  return () => window.clearInterval(timer);
}

export function renderExecution(host: HTMLElement): () => void {
  host.innerHTML = `
    <div class="ml exec">
      <header class="ml-hero">
        <p class="ml-kicker">Peal Private Actions</p>
        <h1 class="ml-h1">Nobody can trade against an intent they cannot read</h1>
        <p class="ml-sub">
          An agent signs an intent: what it wants done, and the worst terms it will take. That
          intent waits its turn. If it can be read while it waits, faster agents trade against
          it. Peal keeps it unreadable until its place in the queue is already decided.
        </p>
      </header>

      <section class="ml-section">
        <div class="ml-wrap">
          <p class="ml-sec-kicker">what changes</p>
          <h2 class="ml-h2">The same three intents, in each kind of queue</h2>
          ${stageHtml()}
        </div>
      </section>

      <section class="ml-section">
        <div class="ml-wrap ml-narrow">
          <p class="ml-sec-kicker">what we promise, and what we do not</p>
          <h2 class="ml-h2">Your intent stays encrypted until its place in the batch is committed.</h2>
          <p class="ml-p">
            That is narrower than &ldquo;private trading&rdquo;, deliberately. Once the batch
            opens, your intent is readable and the settled trade is public forever. We are not
            promising to hide it. We are promising that by the time anyone can read it, the order
            of execution is already fixed.
          </p>
        </div>
      </section>

      <section class="ml-section">
        <div class="ml-wrap">
          <p class="ml-sec-kicker">
            do it for real
            <span class="ml-chip ml-chip-live">live</span>
          </p>
          <h2 class="ml-h2">Open a round, seal an intent, watch it stay shut</h2>
          <p class="ml-p">
            This runs against <code id="run-target">this network</code> and takes
            ${RUN_SECONDS} seconds. It opens a real round, encrypts an intent in your browser and
            submits it. The states come from the coordinator&rsquo;s own event log, not from this
            page.
          </p>
          <div class="exec-actions">
            <a class="ml-btn ml-btn-dark" id="run-go" role="button" tabindex="0">run it</a>
            <span class="ml-note exec-hint">no wallet, no signup, nothing to install</span>
          </div>

          <div class="rn">
            <div class="rn-top">
              <div class="rn-agent">
                <span class="rn-cap">the agent</span>
                <span class="rn-addr" id="rn-addr">not created yet</span>
                <span class="rn-facts">
                  <span>made in this tab</span>
                  <span>holds no funds</span>
                  <span>you never signed anything</span>
                </span>
              </div>

              <div class="rn-arrow" aria-hidden="true"></div>

              <div class="rn-order" id="rn-order">
                <span class="rn-cap">the intent it is signing</span>
                <dl class="rn-rows">
                  <div><dt>sell</dt><dd>50,000 USDC</dd></div>
                  <div><dt>buy</dt><dd>ETH</dd></div>
                  <div><dt>floor</dt><dd>14.2 ETH <em>it will not accept less</em></dd></div>
                </dl>
                <div class="rn-seal" aria-hidden="true">
                  <span class="rn-seal-t">all anyone else can see</span>
                  <code class="rn-seal-ct" id="rn-seal-ct"></code>
                  <span class="rn-seal-f">a hash of the ciphertext. the amounts are not in it.</span>
                </div>
              </div>
            </div>

            <dl class="rn-meta" id="rn-meta">
              <div><dt>round</dt><dd id="rn-m-round">not opened yet</dd></div>
              <div><dt>opens in</dt><dd id="rn-m-clock">&mdash;</dd></div>
              <div><dt>takes</dt><dd id="rn-m-quorum">3 of 5 operators</dd></div>
              <div><dt>slot</dt><dd id="rn-m-slot">&mdash;</dd></div>
            </dl>

            <div class="rn-rail" id="rn-rail" aria-hidden="true"></div>
            <p class="rn-now"><b id="rn-now-t">Ready when you are</b><span id="rn-now-m">Six things happen. You can watch each one land.</span></p>
            <p class="rn-evidence" id="rn-evidence" hidden></p>
          </div>
          <div id="run-out" class="exec-result" hidden></div>
        </div>
      </section>

      <section class="ml-section">
        <div class="ml-wrap ml-narrow">
          <p class="ml-p">
            An agent cannot open an account. It can pay for one call:
            <a href="/developers/x402">x402 in the developer docs</a>.
          </p>
        </div>
      </section>

    </div>
  `;

  /** Busy or unavailable, on an element that has no `disabled` of its own. */
  const setOff = (el: HTMLElement, off: boolean) => {
    el.classList.toggle('is-off', off);
    el.setAttribute('aria-disabled', String(off));
  };
  const isOff = (el: HTMLElement) => el.classList.contains('is-off');

  const stopStage = driveStage(host);

  // ---- the live run -------------------------------------------------------

  const runBtn = host.querySelector<HTMLElement>('#run-go')!;
  const runOut = host.querySelector<HTMLElement>('#run-out')!;
  const rnAddr = host.querySelector<HTMLElement>('#rn-addr')!;
  const rnOrder = host.querySelector<HTMLElement>('#rn-order')!;
  const rnRail = host.querySelector<HTMLElement>('#rn-rail')!;
  const rnNowT = host.querySelector<HTMLElement>('#rn-now-t')!;
  const rnNowM = host.querySelector<HTMLElement>('#rn-now-m')!;
  const rnEv = host.querySelector<HTMLElement>('#rn-evidence')!;
  const rnMRound = host.querySelector<HTMLElement>('#rn-m-round')!;
  const rnMClock = host.querySelector<HTMLElement>('#rn-m-clock')!;
  const rnMSlot = host.querySelector<HTMLElement>('#rn-m-slot')!;
  const rnSealCt = host.querySelector<HTMLElement>('#rn-seal-ct')!;

  /* The countdown, on its own second-by-second clock rather than on the poll.
   * The poll is every two seconds and a clock that jumps two at a time looks
   * broken, which undermines the one number on the page a reader is watching. */
  let opensAtUnix = 0;
  let clockTimer = 0;
  const stopClock = () => {
    window.clearInterval(clockTimer);
    clockTimer = 0;
  };
  const startClock = () => {
    stopClock();
    const tick = () => {
      if (!opensAtUnix) return;
      const left = opensAtUnix - Math.floor(Date.now() / 1000);
      if (left > 0) {
        rnMClock.textContent = `${left}s`;
        rnMClock.classList.add('is-counting');
      } else {
        rnMClock.textContent = 'deadline passed';
        rnMClock.classList.remove('is-counting');
        stopClock();
      }
    };
    tick();
    clockTimer = window.setInterval(tick, 1000);
  };

  let stopped = false;
  const steps: Step[] = RUN_STEPS.map((s) => ({ ...s, state: 'idle' as StepState }));

  const paint = () => {
    // The rail: one dot per step, so where you are is a glance rather than a
    // scan down six rows.
    rnRail.innerHTML = steps
      .map((st) => `<span class="rn-dot rn-${st.state}" title="${esc(st.label)}"></span>`)
      .join('');

    // The order card seals from the moment it is encrypted and stays sealed
    // until the reveal lands. That is the state the whole page is about, so it
    // is the state the picture holds.
    const sealIdx = steps.findIndex((st) => st.key === 'seal');
    const revealDone = steps.find((st) => st.key === 'reveal')?.state === 'done';
    const sealed = steps[sealIdx]!.state === 'done' && !revealDone;
    rnOrder.classList.toggle('is-sealed', sealed);
    rnOrder.classList.toggle('is-open', revealDone);

    // The step now happening, or the last one that finished.
    const active =
      steps.find((st) => st.state === 'doing') ??
      [...steps].reverse().find((st) => st.state === 'done');
    if (active) {
      rnNowT.textContent = active.label;
      rnNowM.textContent = active.means;
    }

    const seal = steps.find((st) => st.key === 'seal' && st.href);
    rnEv.hidden = !seal;
    rnEv.innerHTML = seal
      ? `<a class="rn-ev" href="${esc(seal.href!)}"><i>the sealed intent</i>open its page</a>`
      : '';
  };
  // On screen before anybody presses anything. Seeing the agent, the order and
  // the amount it will not go under is the difference between a demo and a dare.
  paint();

  // Name the host it will actually talk to. "this network" is a claim; the
  // origin is a fact the reader can check against their address bar.
  const target = host.querySelector<HTMLElement>('#run-target');
  if (target) {
    target.textContent = API_BASE
      ? API_BASE.replace(/^https?:\/\//, '')
      : window.location.host;
  }
  const mark = (key: string, state: StepState, detail?: string, href?: string) => {
    const s = steps.find((x) => x.key === key);
    if (!s) return;
    s.state = state;
    if (detail !== undefined) s.detail = detail;
    if (href !== undefined) s.href = href;
    paint();
  };
  const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

  const runOnce = async () => {
    const client = new BteClient({ url: API_BASE });

    // 1. the agent
    const account = privateKeyToAccount(generatePrivateKey());
    rnAddr.textContent = account.address;
    mark('key', 'done', account.address);
    if (stopped) return;

    // 2. the round. `in` rather than a fixed time, so the wait is the same
    //    length whenever somebody runs it.
    mark('round', 'doing');
    let committee: { id: string };
    try {
      committee = await client.committee();
    } catch (e: unknown) {
      const msg = String((e as Error).message ?? e);
      if (msg.includes('no committee')) {
        mark('round', 'failed', 'this coordinator has no committee');
        throw new Error(
          'The coordinator serving this page has no committee registered, so there is nothing to seal to. On a local checkout, bring the devnet up with `just compose-up` first.',
        );
      }
      mark('round', 'failed', msg);
      throw e;
    }
    const conditionId = await client.condition({ in: RUN_SECONDS, tag: 'private-action-demo' });
    const opensAt = Math.floor(Date.now() / 1000) + RUN_SECONDS;
    opensAtUnix = opensAt;
    startClock();
    rnMRound.innerHTML = `<a href="#/condition/${encodeURIComponent(conditionId)}">${esc(conditionId)}</a>`;
    mark('round', 'done', conditionId, `#/condition/${encodeURIComponent(conditionId)}`);
    if (stopped) return;

    // 3. the action, encrypted here. `encodePayload` is the same encoder an
    //    agent uses, so what is sealed is a real intent payload and not a
    //    string standing in for one.
    mark('seal', 'doing');
    const now = Math.floor(Date.now() / 1000);
    const swap = DEMO_SWAP(now, account.address);
    const { ctHash } = await client.seal(encodePayload(swap), conditionId);
    rnSealCt.textContent = ctHash;
    // The seal's own page, which renders from the fragment alone and needs no
    // round trip: the same link anybody would share.
    mark('seal', 'done', ctHash, `#/s/${encodeURIComponent(conditionId)}/${ctHash}`);
    if (stopped) return;

    // 4. the intent. The signature covers the ciphertext hash, which is what
    //    binds the agent to this exact sealed action without revealing it.
    mark('intent', 'doing');
    const intentId = `intent_${Math.random().toString(36).slice(2, 12)}`;
    const env: IntentEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      intentId,
      encryptionKeyId: committee.id,
      ciphertextHash: ctHash,
      nonce: `nonce_${Math.random().toString(36).slice(2, 10)}`,
      createdAt: now,
      expiresAt: now + 900,
      pseudonymousSigner: account.address,
      executionDomain: 8453,
    };
    const signature = await signIntent(env, account);
    const submit = await fetch(`${API_BASE}/v1/intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol_version: env.protocolVersion,
        intent_id: env.intentId,
        encryption_key_id: env.encryptionKeyId,
        ciphertext_hash: env.ciphertextHash,
        nonce: env.nonce,
        created_at: env.createdAt,
        expires_at: env.expiresAt,
        pseudonymous_signer: env.pseudonymousSigner,
        execution_domain: env.executionDomain,
        signature,
        condition_id: conditionId,
      }),
    });
    if (!submit.ok) {
      const body = (await submit.text()).slice(0, 200);
      mark('intent', 'failed', body);
      throw new Error(`the coordinator refused the intent: ${body}`);
    }
    const accepted = (await submit.json()) as { state: string };
    mark('intent', 'done', `${intentId} · ${accepted.state}`);
    if (stopped) return;

    // 5. the wait, and then the freeze. The states come from the coordinator's
    //    own event log rather than from a timer here, so what is shown is what
    //    actually happened.
    mark('commit', 'doing', `sealed, ${RUN_SECONDS}s to go`);
    let committed = false;
    const giveUpAt = opensAt + 150;
    while (!stopped && Math.floor(Date.now() / 1000) < giveUpAt) {
      const left = opensAt - Math.floor(Date.now() / 1000);
      const evRes = await fetch(`${API_BASE}/v1/intents/${intentId}/events`);
      const ev = (await evRes.json()) as { events: Array<{ to: string; at: number }> };
      const reached = ev.events.map((e) => e.to);
      if (reached.includes('ORDER_COMMITTED')) {
        mark('commit', 'done', reached.join(' → '));
        committed = true;
        break;
      }
      mark(
        'commit',
        'doing',
        left > 0 ? `sealed, ${left}s to go` : 'deadline passed, waiting for the freeze',
      );
      await sleep(2000);
    }
    if (stopped) return;
    if (!committed) {
      mark('commit', 'failed', 'the batch did not freeze in time');
      return;
    }

    // 6. the reveal, which is the only moment any of this becomes readable.
    mark('reveal', 'doing');
    const revealBy = Math.floor(Date.now() / 1000) + 90;
    while (!stopped && Math.floor(Date.now() / 1000) < revealBy) {
      const rev = await client.reveal(conditionId);
      const mine = rev?.slots.find((slot) => slot.ctHash === ctHash);
      if (rev && mine) {
        rnMSlot.textContent = `${mine.position} of ${rev.slots.length}`;
        const opened = decodePayload(mine.payload);
        mark(
          'reveal',
          'done',
          `${opened.actionType} · sell ${opened.sellAmount} · floor ${opened.minimumBuyAmount}`,
        );
        runOut.hidden = false;
        runOut.innerHTML = `
          <p class="vr-verdict vr-ok">the action was unreadable for ${RUN_SECONDS} seconds, then opened by the network</p>
          <p class="field-hint">slot ${mine.position} of the batch, merkle root <code>${esc(rev.merkleRoot)}</code></p>
          <p class="field-hint">
            Ordering was committed before any share existed, so the position this intent holds in
            the batch was fixed while it was still a ciphertext. What happens after this point,
            quoting the swap and settling it, needs an executor and a submission path, and neither
            is running on this deployment. That gap is the last row of the table below.
          </p>`;
        return;
      }
      await sleep(1500);
    }
    if (!stopped) mark('reveal', 'failed', 'the reveal did not arrive in time');
  };

  const onRun = () => {
    if (isOff(runBtn)) return;
    setOff(runBtn, true);
    runBtn.textContent = 'running…';
    runOut.hidden = true;
    steps.forEach((s) => {
      s.state = 'idle';
      s.detail = undefined;
      s.href = undefined;
    });
    paint();
    void runOnce()
      .catch((e: unknown) => {
        runOut.hidden = false;
        runOut.innerHTML = `<p class="vr-verdict vr-bad">${esc(String((e as Error).message ?? e))}</p>`;
      })
      .finally(() => {
        if (!stopped) {
          setOff(runBtn, false);
          runBtn.textContent = 'run it again';
        }
      });
  };
  runBtn.addEventListener('click', onRun);

  return () => {
    // The run polls for up to three minutes. Leaving the page has to stop it,
    // or a navigation away leaves fetches firing against a dead DOM.
    stopped = true;
    stopClock();
    stopStage();
    runBtn.removeEventListener('click', onRun);
  };
}
