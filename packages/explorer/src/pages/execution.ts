// Private Actions: the /execution section.
//
// Two jobs, and one deliberate omission.
//
// It explains the guarantee in the exact words the protocol can defend — the
// eight-stage lifecycle, and who can see what at each stage. And it ships a
// receipt verifier that really runs `verifyReceipt` from peal-actions in the
// visitor's own tab: paste a receipt, get every check individually pass or
// fail. That is the whole point of a verifiable receipt, so it should not
// require trusting this page either.
//
// What it does NOT do is show a live intent feed. The /v1 API exists now, but a
// public deployment has no real intents in it, and a dashboard of invented
// swaps is the one thing this product cannot afford to ship. The build status
// below says plainly what is live and what is not.
import { verifyReceipt, type ExecutionReceipt, type VerificationReport } from 'peal-actions';
import { esc } from '../util';

/** The lifecycle, in the order it happens, with who can read the action at
 * each point. The "visible to" column is the honest half: after stage 6 the
 * plaintext exists, and pretending otherwise is how privacy products lose
 * their users' trust. */
const LIFECYCLE = [
  { n: 1, stage: 'Encrypted locally', who: 'the agent only', sealed: true },
  { n: 2, stage: 'Submitted as ciphertext', who: 'the agent only', sealed: true },
  { n: 3, stage: 'Included in batch', who: 'the agent only', sealed: true },
  { n: 4, stage: 'Order locked', who: 'the agent only', sealed: true },
  { n: 5, stage: 'Threshold reached', who: 'the agent only', sealed: true },
  { n: 6, stage: 'Revealed to executor', who: 'the executor, and anyone holding t shares', sealed: false },
  { n: 7, stage: 'Submitted for execution', who: 'the liquidity API and the submission path', sealed: false },
  { n: 8, stage: 'Publicly settled', who: 'everyone, permanently', sealed: false },
];

/** Component status. Each line is checked against the tree, not aspirational.
 * `state` is one of: live (works today), partial, planned. */
const STATUS = [
  { part: 'Threshold encryption, 3-of-5 committee', state: 'live', note: 'existing bte-crypto; unchanged by this work' },
  { part: 'Batching, freeze, deterministic ordering', state: 'live', note: 'positions are a pure function of the ciphertext set' },
  { part: 'Share verification and reveal', state: 'live', note: 'every share pairing-checked before use' },
  { part: 'Intent schema and privacy boundary', state: 'live', note: 'packages/actions: envelope vs encrypted payload' },
  { part: 'EIP-712 intent and authorization signing', state: 'live', note: 'agent keys never leave the agent' },
  { part: 'Lifecycle state machine', state: 'live', note: 'quoting is unreachable before order-commit + reveal' },
  { part: 'Ordering commitment and inclusion proofs', state: 'live', note: 'merkle over (intentId, ciphertextHash), written inside the freeze transaction' },
  { part: 'Receipt build and verification', state: 'live', note: 'the verifier below runs it' },
  { part: 'Coordinator /v1 intent API', state: 'live', note: 'submit, read, events, batch commitment, authorization' },
  { part: '0x Swap API v2 adapter', state: 'live', note: 'quote requested only after reveal, validated against the signed floor' },
  { part: 'Across cross-chain adapter', state: 'partial', note: 'implemented and tested; ships disabled until credentials are configured' },
  { part: 'Submission provider abstraction', state: 'partial', note: 'policy and simulator done; no live private relay wired yet' },
  { part: 'Example agent, end-to-end live swap', state: 'planned', note: 'the remaining gap to a real settled trade' },
];

function lifecycleRows(): string {
  return LIFECYCLE.map(
    (s) => `
      <tr class="${s.sealed ? 'lc-sealed' : 'lc-open'}">
        <td class="lc-n">${s.n}</td>
        <td class="lc-stage">${esc(s.stage)}</td>
        <td class="lc-who">${esc(s.who)}</td>
        <td class="lc-flag">${s.sealed ? 'encrypted' : 'readable'}</td>
      </tr>`,
  ).join('');
}

function statusRows(): string {
  return STATUS.map(
    (s) => `
      <tr>
        <td><span class="st-dot st-${s.state}"></span>${esc(s.state)}</td>
        <td>${esc(s.part)}</td>
        <td class="muted">${esc(s.note)}</td>
      </tr>`,
  ).join('');
}

function reportHtml(report: VerificationReport): string {
  const rows = report.checks
    .map(
      (c) => `
        <li class="vr-check ${c.ok ? 'vr-ok' : 'vr-bad'}">
          <span class="vr-mark">${c.ok ? '✓' : '✗'}</span>
          <span class="vr-name">${esc(c.name)}</span>
          ${c.detail ? `<span class="vr-detail">${esc(c.detail)}</span>` : ''}
        </li>`,
    )
    .join('');
  const failed = report.checks.filter((c) => !c.ok).length;
  return `
    <p class="vr-verdict ${report.ok ? 'vr-ok' : 'vr-bad'}">
      ${report.ok ? 'every check passed' : `${failed} check${failed === 1 ? '' : 's'} failed`}
    </p>
    <ul class="vr-list">${rows}</ul>
    <p class="field-hint">
      Executor and coordinator signatures show as failed unless a verifier is supplied:
      this page checks receipt structure, agent signature, batch inclusion and the
      settled floor, and refuses to tick a box it did not actually verify.
    </p>`;
}

export function renderExecution(host: HTMLElement): () => void {
  host.innerHTML = `
    <section class="exec">
      <header class="exec-head">
        <p class="exec-kicker">Peal Private Actions</p>
        <h1 class="exec-title">Private execution for autonomous agents</h1>
        <p class="exec-lede">
          An agent signs and encrypts an action on its own device. Peal keeps it
          confidential while it is batched and ordered, reveals it only after the
          ordering is locked, executes it through external liquidity, and returns
          a receipt the agent can verify without trusting us.
        </p>
      </header>

      <div class="exec-claim card">
        <h2>The guarantee, stated exactly</h2>
        <p class="exec-guarantee">
          Intent contents remain encrypted until batch inclusion and ordering are
          committed.
        </p>
        <p>
          That is the whole claim, and it is deliberately narrower than
          &ldquo;private trading&rdquo;. Peal does <strong>not</strong> promise
          permanent transaction privacy. After the threshold reveal, the executor
          reads the action, the liquidity API sees a quote request, and the
          settled transaction is public forever. Peal does not eliminate every
          form of MEV; it removes the window in which someone could reorder around
          you, because ordering is fixed while the batch is still unreadable.
        </p>
      </div>

      <div class="exec-block">
        <h2>Who can see what, and when</h2>
        <table class="exec-table lifecycle">
          <thead><tr><th></th><th>stage</th><th>visible to</th><th></th></tr></thead>
          <tbody>${lifecycleRows()}</tbody>
        </table>
        <p class="field-hint">
          Stages 1&ndash;5 are the product. Stages 6&ndash;8 are the honest cost of
          settling on a public chain.
        </p>
      </div>

      <div class="exec-block">
        <h2>Verify a receipt</h2>
        <p>
          Paste an execution receipt. Verification runs entirely in this tab
          against the same code an agent would run locally &mdash; nothing is sent
          anywhere, and this page has no privileged knowledge of the answer.
        </p>
        <textarea id="exec-receipt" class="exec-input" rows="8"
          spellcheck="false" placeholder='{ "receiptVersion": 1, "intentId": "...", ... }'></textarea>
        <div class="exec-actions">
          <button type="button" class="btn btn-primary" id="exec-verify">verify receipt</button>
          <button type="button" class="btn" id="exec-clear">clear</button>
        </div>
        <div id="exec-result" class="exec-result" hidden></div>
      </div>

      <div class="exec-block">
        <h2>What is built</h2>
        <p class="field-hint">
          No live intent feed here: this deployment has no real intents to show,
          and a dashboard of invented activity would undermine the one thing this
          product sells. Every row below is checked against the tree.
        </p>
        <table class="exec-table status">
          <thead><tr><th>state</th><th>component</th><th>note</th></tr></thead>
          <tbody>${statusRows()}</tbody>
        </table>
      </div>
    </section>
  `;

  const input = host.querySelector<HTMLTextAreaElement>('#exec-receipt')!;
  const result = host.querySelector<HTMLElement>('#exec-result')!;
  const verifyBtn = host.querySelector<HTMLButtonElement>('#exec-verify')!;
  const clearBtn = host.querySelector<HTMLButtonElement>('#exec-clear')!;

  const show = (html: string) => {
    result.hidden = false;
    result.innerHTML = html;
  };

  const onVerify = () => {
    const raw = input.value.trim();
    if (!raw) {
      show('<p class="vr-verdict vr-bad">paste a receipt first</p>');
      return;
    }
    let parsed: ExecutionReceipt;
    try {
      parsed = JSON.parse(raw) as ExecutionReceipt;
    } catch (e) {
      show(`<p class="vr-verdict vr-bad">not valid JSON: ${esc(String(e))}</p>`);
      return;
    }
    verifyBtn.disabled = true;
    // No verifier callbacks: the executor and coordinator signatures are
    // deployment policy, so they are reported as unchecked rather than passed.
    void verifyReceipt(parsed)
      .then((report) => show(reportHtml(report)))
      .catch((e: unknown) => show(`<p class="vr-verdict vr-bad">could not verify: ${esc(String(e))}</p>`))
      .finally(() => {
        verifyBtn.disabled = false;
      });
  };

  const onClear = () => {
    input.value = '';
    result.hidden = true;
    result.innerHTML = '';
  };

  verifyBtn.addEventListener('click', onVerify);
  clearBtn.addEventListener('click', onClear);

  return () => {
    verifyBtn.removeEventListener('click', onVerify);
    clearBtn.removeEventListener('click', onClear);
  };
}
