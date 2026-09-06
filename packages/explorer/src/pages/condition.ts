import {
  getCommittee,
  getCondition,
  getReveal,
  type Batch,
  type CommitteeDetail,
  type ConditionDetail,
  type Reveal,
} from '../api';
import { wireCopy } from '../playground';
import { isPrivatePayload } from '../privacy';
import { getReadConfig, type MempoolConfig } from '../mempool/chain';
import { normalizeHex } from '../merkle';
import { verifyReveal, type Check, type VerifyReport } from '../verify';
import {
  decodePayload,
  esc,
  fmtCountdown,
  fmtUnix,
  payloadBytes,
  statusChip,
  tagLabel,
  truncMiddle,
} from '../util';

const POLL_MS = 2000;

export function renderCondition(root: HTMLElement, id: string): () => void {
  root.innerHTML = `
    <p class="backlink-row"><a class="link" href="/#/app">&larr; all conditions</a></p>
    <section class="section">
      <h1>condition
        <button type="button" class="hash-copy mono" data-copy="${esc(id)}" title="copy condition id">${esc(
          truncMiddle(id, 14, 6),
        )}</button>
      </h1>
      <div id="meta" class="card">
        <div class="skeleton-row">
          <span class="skeleton" style="width:80px"></span>
          <span class="skeleton" style="width:140px"></span>
          <span class="skeleton" style="width:110px"></span>
        </div>
      </div>
      <div id="stage"></div>
    </section>
    <div id="reveal"></div>
  `;
  wireCopy(root);

  const metaEl = root.querySelector<HTMLElement>('#meta')!;
  const stageEl = root.querySelector<HTMLElement>('#stage')!;
  const revealEl = root.querySelector<HTMLElement>('#reveal')!;

  let condition: ConditionDetail | null = null;
  let committee: CommitteeDetail | null = null;
  let revealed = false;
  let pollTimer: number | undefined;
  let tickTimer: number | undefined;

  void getCommittee()
    .then((c) => {
      committee = c;
      renderStage();
    })
    .catch(() => {});

  // The chain endpoint and the PealMempool address come from the relayer, but
  // nothing is TAKEN from it: the browser reads the chain itself, and both the
  // address and the RPC are printed in the panel so they can be checked.
  // Reading the chain does not need the relayer: it needs an RPC and an
  // address, and the browser can do that itself.
  const configReady: Promise<MempoolConfig | null> = getReadConfig().catch(() => null);

  /** Countdown or live share progress, depending on status. */
  const renderStage = () => {
    if (!condition || revealed) {
      stageEl.innerHTML = '';
      return;
    }
    if (condition.status === 'pending' && condition.fires_at != null) {
      const secs = condition.fires_at - Math.floor(Date.now() / 1000);
      stageEl.innerHTML = `
        <div class="stage-panel">
          <p class="stage-line">sealed board is dark. reveals in
            <span class="countdown-big num">${esc(fmtCountdown(secs))}</span></p>
        </div>`;
      return;
    }
    if (condition.status === 'frozen' || condition.status === 'stalled') {
      const t = committee?.t ?? 3;
      const n = committee?.n ?? 5;
      const verified = Math.max(0, ...condition.batches.map((b) => b.verified_shares ?? 0));
      const dots = Array.from({ length: n }, (_, i) =>
        i < verified
          ? '<span class="dot dot-done"></span>'
          : '<span class="dot dot-wait"></span>',
      ).join('');
      const stalledNote =
        condition.status === 'stalled'
          ? `<p class="error">stalled. fewer than ${t} verified shares arrived before the timeout. a late share still completes it.</p>`
          : '';
      stageEl.innerHTML = `
        <div class="stage-panel">
          <p class="stage-line">batch frozen. operator shares:
            <strong class="num">${verified}</strong> verified, <strong class="num">${t}</strong> needed</p>
          <div class="pg-operators">${dots}<span class="pg-operators-label">any ${t} of ${n} recover everything</span></div>
          ${stalledNote}
        </div>`;
    }
  };

  const poll = async () => {
    try {
      condition = await getCondition(id);
    } catch (e) {
      metaEl.innerHTML = `<p class="error">could not load this condition (${esc(String(e))}). <a class="link" href="/#/app">back to the list</a></p>`;
      return;
    }
    metaEl.innerHTML = metaCard(condition);
    renderStage();

    if (condition.status === 'revealed' && !revealed) {
      const reveal = await getReveal(id).catch(() => null);
      if (reveal) {
        revealed = true;
        renderStage();
        revealEl.innerHTML = revealSection(reveal, condition);
        wireCopy(revealEl);
        void runVerification(revealEl, reveal, committee, configReady, condition.tag);
        if (pollTimer !== undefined) clearInterval(pollTimer);
        if (tickTimer !== undefined) clearInterval(tickTimer);
      }
    } else if (!revealed) {
      revealEl.innerHTML = `<section class="section"><p class="muted">nothing to show yet. plaintexts appear here the moment the reveal lands.</p></section>`;
    }
  };

  void poll();
  pollTimer = window.setInterval(() => void poll(), POLL_MS);
  tickTimer = window.setInterval(renderStage, 1000);

  return () => {
    if (pollTimer !== undefined) clearInterval(pollTimer);
    if (tickTimer !== undefined) clearInterval(tickTimer);
  };
}

/** Run the real checks and paint the results. Nothing here compares a
 * coordinator value against another coordinator value: the roots come off the
 * chain, the hashes off the ciphertext bytes, the quorum out of a pairing
 * equation. It runs on load rather than behind a button, because a check you
 * have to ask for is a check nobody runs. */
async function runVerification(
  scope: HTMLElement,
  r: Reveal,
  committee: CommitteeDetail | null,
  configReady: Promise<MempoolConfig | null>,
  tag: string | null | undefined,
): Promise<void> {
  const out = scope.querySelector<HTMLElement>('#verify-panel');
  if (!out) return;
  const cfg = await configReady;
  let report: VerifyReport;
  try {
    report = await verifyReveal(r, cfg, committee, tag === 'mempool' ? 'order' : 'seal');
  } catch (e) {
    out.className = 'verify-panel verify-bad';
    out.innerHTML = `<p>could not run the checks (${esc(String(e))}).</p>`;
    return;
  }

  const failed = report.checks.filter((c) => c.status === 'fail');
  const passed = report.checks.filter((c) => c.status === 'pass');

  const summary = failed.length
    ? `<p class="verify-summary verify-bad-text"><strong>${failed.length} of ${report.checks.length} checks failed.</strong>
       this reveal does not match what was committed.</p>`
    : report.anchored
      ? `<p class="verify-summary">every check below was recomputed in this browser and held against the
         chain, the ciphertext bytes and the operators' shares. no result here rests on the
         coordinator's word.</p>`
      : `<p class="verify-summary">every check below was recomputed in this browser from the sealed
         ciphertexts and the operators' shares. no result here rests on the coordinator's word.</p>`;

  // Grouped by what backs each claim, strongest evidence first: a reader should
  // be able to see at a glance which results survive a dishonest coordinator.
  const groups: { title: string; note: string; of: Check['anchor'][] }[] = [
    { title: 'anchored on-chain', note: 'read from the contract by this browser, over the public rpc', of: ['chain'] },
    { title: 'cryptographic', note: 'recomputed here from the sealed bytes and the operators\' shares', of: ['crypto'] },
    { title: 'structural', note: 'derived from data the merkle root above already fixes', of: ['local'] },
    { title: 'not checkable here', note: 'stated rather than passed over in silence', of: ['none'] },
  ];

  const sections = groups
    .map(({ title, note, of }) => {
      const rows = report.checks.filter((c) => of.includes(c.anchor));
      if (!rows.length) return '';
      return `
        <section class="verify-group">
          <h3 class="verify-group-title">${esc(title)}<span class="verify-group-note">${esc(note)}</span></h3>
          <ul class="verify-list">${rows.map(checkRow).join('')}</ul>
        </section>`;
    })
    .join('');

  out.className = `verify-panel${failed.length ? ' verify-bad' : ''}`;
  out.innerHTML = `
    <div class="verify-head">
      <h3 class="verify-title">verification
        <span class="verify-count ${failed.length ? 'verify-count-bad' : 'verify-count-ok'}">${passed.length}/${report.checks.length}</span>
      </h3>
      ${summary}
    </div>
    ${sections}
    ${verifyFooter(report, r, cfg)}
  `;

  // Now that the Sealed logs are in, turn each ct hash in the table into a link
  // to the transaction that committed it, before the reveal existed.
  if (cfg?.explorerBase) {
    scope.querySelectorAll<HTMLElement>('[data-ct]').forEach((cell) => {
      const commit = report.sealedCommits.get(normalizeHex(cell.dataset.ct ?? ''));
      if (!commit) return;
      const url = `${cfg.explorerBase.replace(/\/$/, '')}/tx/${commit.txHash}`;
      cell.innerHTML = `<a class="link mono" href="${esc(url)}" target="_blank" rel="noopener"
        title="committed on-chain in block ${commit.blockNumber}, before the reveal">${cell.innerHTML}</a>`;
    });
  }
}

/** One claim. The group heading already says what backs it, so the row carries
 * only the verdict, the claim, and the evidence. */
function checkRow(c: Check): string {
  const mark =
    c.status === 'pass'
      ? '<span class="verify-mark verify-mark-ok" aria-hidden="true">&check;</span>'
      : c.status === 'fail'
        ? '<span class="verify-mark verify-mark-bad" aria-hidden="true">&times;</span>'
        : '<span class="verify-mark verify-mark-skip" aria-hidden="true">&ndash;</span>';
  return `
    <li class="verify-item verify-${c.status}">
      ${mark}
      <div class="verify-body">
        <p class="verify-claim">${esc(c.label)}</p>
        <p class="verify-detail">${c.detail}</p>
      </div>
    </li>`;
}

/** The honest footer. Every one of these limits is real, and hiding them would
 * make the panel above worth less, not more. */
function verifyFooter(report: VerifyReport, r: Reveal, cfg: MempoolConfig | null): string {
  const settleUrl =
    report.settleTx && cfg?.explorerBase
      ? `${cfg.explorerBase.replace(/\/$/, '')}/tx/${report.settleTx}`
      : null;
  const settle = settleUrl
    ? `<a class="link" href="${esc(settleUrl)}" target="_blank" rel="noopener">the settlement transaction</a>`
    : '';
  // A capsule or a round never goes on-chain, so its honest limits are a
  // different set from the mempool lane's. Saying "the chain fixes the record"
  // under a condition that has no chain record would be worse than saying
  // nothing.
  const limits = report.anchored
    ? `<p>the chain fixes which plaintexts were settled and makes them permanent. it does not
       prove the coordinator was honest while assembling the batch, because
       <code>executeBatch</code> is coordinator-only: what the chain pins is the record, not
       the intent. the structural checks above are what constrain the intent, since a
       coordinator that reordered or suppressed an order could not satisfy them.</p>`
    : `<p>this condition was not committed on-chain, which is normal: only the mempool lane
       settles. the shares above still prove a threshold of operators performed the
       decryption, and the hashes still bind the plaintexts to the ciphertexts they came
       from. what is missing without a commitment is a public record of the ciphertext set
       made before the reveal, so a ciphertext dropped before the batch froze would leave no
       trace here.</p>`;
  return `
    <details class="verify-more">
      <summary>what this does not prove, and how to check it yourself</summary>
      ${limits}
      <p>a ciphertext also carries no proof of which committee it was sealed to. that is a
      property of the scheme rather than this deployment, and no api surface would fix it.</p>
      <p>run it all yourself:
      <a class="link" download="peal-batch-${esc(r.condition_id)}.json"
         href="data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(r, null, 2))}">download
      the batch json</a> ${settle ? `or open ${settle}` : ''}. the json carries the sealed
      ciphertexts, the plaintexts and the operator shares, which is everything the checks
      above consume.</p>
    </details>`;
}

function metaCard(c: ConditionDetail): string {
  const fires =
    c.fires_at != null
      ? esc(fmtUnix(c.fires_at))
      : c.height != null
        ? `block ${c.height} on chain ${c.chain_id}`
        : '<span class="muted">unknown</span>';
  const what = tagLabel(c.tag);
  return `
    <dl class="stats">
      <div><dt>status</dt><dd>${statusChip(c.status)}</dd></div>
      ${what ? `<div><dt>what</dt><dd>${esc(what)}</dd></div>` : ''}
      <div><dt>kind</dt><dd>${esc(c.kind)}</dd></div>
      <div><dt>fires at</dt><dd>${fires}</dd></div>
      <div><dt>sealed</dt><dd class="num">${c.real_count}<span class="muted"> real / ${c.ciphertext_count} total</span></dd></div>
      <div><dt>created</dt><dd>${esc(fmtUnix(c.created_at))}</dd></div>
    </dl>
  `;
}

function revealSection(r: Reveal, c: ConditionDetail): string {
  const real = r.slots.filter((s) => !s.is_dummy).length;
  const finalizeMs = Math.max(0, ...r.batches.map((b) => b.finalize_ms ?? 0));
  return `
    <section class="section reveal-in">
      <h2>revealed</h2>
      <div class="card reveal-card">
        <dl class="stats">
          <div><dt>opened</dt><dd>${esc(fmtUnix(r.revealed_at))}</dd></div>
          <div><dt>sealed ${c.tag === 'mempool' ? 'orders' : 'seals'}</dt><dd class="num">${real}<span class="muted"> of ${r.slots.length} slots</span></dd></div>
          <div><dt>reveal took</dt><dd class="num">${finalizeMs} ms</dd></div>
          <div><dt>merkle root</dt><dd>
            <button type="button" class="hash-copy mono" data-copy="${esc(r.merkle_root)}"
                    title="copy merkle root">${esc(truncMiddle(r.merkle_root, 12, 10))}</button>
          </dd></div>
        </dl>
        <p class="trust-note">the merkle root commits to every slot below, padding included.</p>
        <div id="verify-panel" class="verify-panel">
          <p class="verify-summary"><span class="mp-spinner" aria-hidden="true"></span>
          reading the chain and recomputing the checks…</p>
        </div>
        ${slotGrid(r)}
      </div>
      ${boardTable(r)}
    </section>
    <section class="section reveal-in">
      <h2>operator shares</h2>
      ${shareTable(r)}
    </section>
    <section class="section reveal-in">
      <h2>batch timings</h2>
      <p class="muted">the pre-decrypt work ran while shares were still in flight, so the
      reveal only had to wait for finalize.</p>
      ${timingBars(r.batches.length ? r.batches : c.batches)}
    </section>
  `;
}

/** The whole batch at a glance: one cell per slot, sealed orders pop out of the
 * padding, corrupt slots go red, private ones carry a lock. */
function slotGrid(r: Reveal): string {
  const cells = r.slots
    .map((s) => {
      const priv = !s.is_dummy && s.valid && isPrivatePayload(payloadBytes(s.payload_b64));
      const cls = !s.valid
        ? 'slot-cell slot-corrupt'
        : s.is_dummy
          ? 'slot-cell slot-dummy'
          : priv
            ? 'slot-cell slot-real slot-private'
            : 'slot-cell slot-real';
      const what = !s.valid ? 'corrupt' : s.is_dummy ? 'padding' : priv ? 'private seal' : 'revealed seal';
      return `<span class="${cls}" title="slot ${s.position}: ${what}"></span>`;
    })
    .join('');
  return `
    <div class="slot-grid" role="img" aria-label="batch of ${r.slots.length} slots">${cells}</div>
    <p class="slot-legend muted">
      <span class="slot-cell slot-real"></span> revealed
      <span class="slot-cell slot-real slot-private"></span> private
      <span class="slot-cell slot-dummy"></span> padding
    </p>`;
}

function slotRow(s: Reveal['slots'][number], stagger: number): string {
  const tags: string[] = [];
  const priv = !s.is_dummy && s.valid && isPrivatePayload(payloadBytes(s.payload_b64));
  if (s.is_dummy) tags.push('<span class="tag tag-dummy">padding</span>');
  if (!s.valid) tags.push('<span class="tag tag-corrupt">corrupt</span>');
  if (priv) tags.push('<span class="tag tag-private">private</span>');
  const decoded = decodePayload(s.payload_b64);
  const payload = !s.valid
    ? '<span class="muted">unrecoverable</span>'
    : s.is_dummy
      ? '<span class="muted">padding</span>'
      : priv
        ? '<span class="muted">🔒 opens only with its share link</span>'
        : `<span class="${decoded.isHex ? 'mono' : 'payload-text'}">${esc(decoded.text)}</span>`;
  return `<tr class="${s.is_dummy ? 'dummy-row' : ''} board-row" style="--stagger:${stagger}ms">
    <td class="num">${s.position}</td>
    <td><span class="mono" data-ct="${esc(s.ct_hash)}" title="${esc(s.ct_hash)}">${esc(truncMiddle(s.ct_hash, 12, 10))}</span></td>
    <td>${payload} ${tags.join(' ')}</td>
  </tr>`;
}

/** Real (and corrupt) slots only; healthy padding stays in the grid above.
 * The table closes with one line saying how much padding filled the batch. */
function boardTable(r: Reveal): string {
  const interesting = r.slots.filter((s) => !s.is_dummy || !s.valid);
  const padding = r.slots.filter((s) => s.is_dummy && s.valid);

  const shown = interesting
    .map((s, i) => slotRow(s, Math.min(i, 12) * 18))
    .join('');
  const note =
    padding.length > 0
      ? `<tr class="padding-note-row"><td colspan="3">
           <span class="muted">+ ${padding.length} padding slots keep the batch at ${r.slots.length},
           fixed by the ceremony. all ${r.slots.length} are committed in the merkle root.</span>
         </td></tr>`
      : '';
  return `<div class="table-wrap"><table>
    <thead><tr><th>slot</th><th>before, sealed (ct hash)</th><th>after, revealed</th></tr></thead>
    <tbody>${shown}${note}</tbody>
  </table></div>`;
}

function shareTable(r: Reveal): string {
  if (r.shares.length === 0) return '<p class="muted">no shares recorded.</p>';
  const first = Math.min(...r.shares.map((s) => s.submitted_at_ms));
  const rows = r.shares
    .map(
      (s) => `<tr class="${s.verified ? '' : 'share-rejected'}">
        <td>operator ${s.operator_id}</td>
        <td class="num">+${s.submitted_at_ms - first} ms</td>
        <td>${s.verified ? '<span class="ok">verified</span>' : '<strong>rejected</strong>'}</td>
      </tr>`,
    )
    .join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>operator</th><th>submitted</th><th>pairing check</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

/** Proportional bars: pre-decrypt (pipelined away) vs finalize (user-felt). */
function timingBars(batches: Batch[]): string {
  if (batches.length === 0) return '<p class="muted">no batch timings recorded.</p>';
  const max = Math.max(1, ...batches.map((b) => Math.max(b.predecrypt_ms ?? 0, b.finalize_ms ?? 0)));
  return batches
    .map((b) => {
      const pre = b.predecrypt_ms ?? 0;
      const fin = b.finalize_ms ?? 0;
      return `
      <div class="timing">
        <div class="timing-row">
          <span class="timing-label">pre-decrypt (pipelined)</span>
          <div class="timing-track"><div class="timing-bar timing-bar-pre" style="width:${Math.max(2, (pre / max) * 100)}%"></div></div>
          <span class="num timing-ms">${pre} ms</span>
        </div>
        <div class="timing-row">
          <span class="timing-label">finalize</span>
          <div class="timing-track"><div class="timing-bar timing-bar-fin" style="width:${Math.max(2, (fin / max) * 100)}%"></div></div>
          <span class="num timing-ms">${fin} ms</span>
        </div>
      </div>`;
    })
    .join('');
}
