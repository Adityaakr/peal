import { getCommittee, listConditionsWithTotal, type ConditionSummary } from '../api';
import { forgetSeal, listSeals, markSealRevealed, type WatchedSeal } from '../attention';
import { renderPlayground } from '../playground';
import { esc, fmtCountdown, fmtRelative, statusChip, tagLabel, truncMiddle } from '../util';

const POLL_MS = 2000;

export function renderHome(root: HTMLElement): () => void {
  root.innerHTML = `
    <section class="hero">
      <h1 class="hero-title">encryption with a release date</h1>
      <p class="hero-sub">secrets that open themselves add them to your dapp in minutes.
      seal data to a cue (a time, a block, a condition, an event) and when it fires, the
      whole batch opens at once: no second transaction, no selective reveal. built on
      batched threshold encryption; decentralized operator committee on the roadmap.</p>
      <div id="playground"></div>
    </section>
    <section class="section" id="seals-section" hidden>
      <h2>your seals</h2>
      <div id="seals" class="table-wrap"></div>
    </section>
    <section class="section">
      <h2>committee</h2>
      <div id="committee" class="card">
        <div class="skeleton-row">
          <span class="skeleton" style="width:72px"></span>
          <span class="skeleton" style="width:96px"></span>
          <span class="skeleton" style="width:80px"></span>
          <span class="skeleton" style="width:180px"></span>
        </div>
      </div>
    </section>
    <section class="section">
      <h2>conditions <span class="section-count" id="conditions-total" aria-live="polite"></span></h2>
      <div id="conditions" class="table-wrap">
        <div class="skeleton-row">
          <span class="skeleton" style="width:100%"></span>
        </div>
      </div>
    </section>
  `;

  const cleanupPlayground = renderPlayground(root.querySelector<HTMLElement>('#playground')!);
  const committeeEl = root.querySelector<HTMLElement>('#committee')!;
  const conditionsEl = root.querySelector<HTMLElement>('#conditions')!;
  const sealsSection = root.querySelector<HTMLElement>('#seals-section')!;
  const sealsEl = root.querySelector<HTMLElement>('#seals')!;

  void loadCommittee(committeeEl);

  sealsEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-forget]');
    if (!btn) return;
    const [conditionId, ctHash] = (btn.dataset.forget ?? '').split('/');
    if (conditionId && ctHash) forgetSeal(conditionId, ctHash);
    renderSeals();
  });

  let lastConditions: ConditionSummary[] = [];
  let listLoaded = false;
  let lastSealsHtml = '';
  const renderSeals = () => {
    const seals = listSeals();
    sealsSection.hidden = seals.length === 0;
    if (seals.length === 0) return;
    const html = sealsTable(seals, lastConditions, listLoaded);
    if (html !== lastSealsHtml) {
      sealsEl.innerHTML = html;
      lastSealsHtml = html;
    }
  };

  let lastRendered = '';
  let lastTotal: number | null = null;

  /** Show how many there are, and make it visible when it moves. */
  function paintTotal(total: number, approximate: boolean): void {
    const el = root.querySelector<HTMLElement>('#conditions-total');
    if (!el) return;
    el.textContent = approximate ? `${total}+` : String(total);
    el.title = approximate
      ? 'this coordinator does not report a total, so this is what the list returned'
      : 'every condition this coordinator has ever held';
    if (lastTotal !== null && total > lastTotal) {
      // Restart the animation rather than relying on the class being absent.
      el.classList.remove('is-up');
      void el.offsetWidth;
      el.classList.add('is-up');
    }
    lastTotal = total;
  }
  const poll = async () => {
    try {
      const { conditions, total } = await listConditionsWithTotal();
      // The count is the network's, not this list's: the endpoint returns at
      // most a hundred, so counting the array would stop moving at exactly the
      // point there is most to watch.
      paintTotal(total ?? conditions.length, total === null);
      lastConditions = conditions;
      listLoaded = true;
      // Anything the network says is revealed gets flagged in the local list.
      for (const c of conditions) {
        if (c.status === 'revealed') markSealRevealed(c.id);
      }
      const html = conditionsTable(conditions);
      if (html !== lastRendered) {
        conditionsEl.innerHTML = html;
        lastRendered = html;
      }
      renderSeals();
    } catch (e) {
      if (!lastRendered) {
        conditionsEl.innerHTML = `<p class="error">could not reach the coordinator (${esc(String(e))}). start it with <span class="mono">just compose-up</span>, then reload.</p>`;
      }
    }
  };
  renderSeals();
  void poll();
  const timer = setInterval(() => void poll(), POLL_MS);
  const tick = setInterval(renderSeals, 1000);
  return () => {
    clearInterval(timer);
    clearInterval(tick);
    cleanupPlayground();
  };
}

async function loadCommittee(committeeEl: HTMLElement): Promise<void> {
  try {
    const c = await getCommittee();
    const roster = Array.from(
      { length: c.n },
      (_, i) => `<span class="operator">operator ${i + 1}</span>`,
    ).join('');
    committeeEl.innerHTML = `
      <dl class="stats">
        <div><dt>operators</dt><dd class="num">${c.n}</dd></div>
        <div><dt>threshold</dt><dd class="num">${c.t} of ${c.n}</dd></div>
        <div><dt>batch size</dt><dd class="num">${c.b}</dd></div>
        <div><dt>params digest</dt><dd>
          <button type="button" class="hash-copy mono" data-copy="${esc(c.params_digest)}"
                  title="copy params digest">${esc(truncMiddle(c.params_digest, 12, 10))}</button>
        </dd></div>
      </dl>
      <div class="roster">${roster}</div>
    `;
    import('../playground').then(({ wireCopy }) => wireCopy(committeeEl));
  } catch (e) {
    committeeEl.innerHTML = `<p class="error">could not load the committee (${esc(String(e))}). is a committee registered?</p>`;
  }
}

function sealsTable(
  seals: WatchedSeal[],
  conditions: ConditionSummary[],
  listLoaded: boolean,
): string {
  const now = Math.floor(Date.now() / 1000);
  const byId = new Map(conditions.map((c) => [c.id, c]));
  const rows = seals
    .map((s) => {
      const live = byId.get(s.conditionId);
      const revealed = s.revealed || live?.status === 'revealed';
      const firesAt = live?.fires_at ?? s.firesAt;
      // The devnet wipes on reset: a pending seal whose condition the
      // coordinator no longer knows is dead, not counting down.
      const gone = listLoaded && !live && !revealed;
      let state: string;
      if (gone) {
        state = `<span class="chip chip-pending" title="the devnet was reset since this was sealed; the condition no longer exists">gone, devnet reset</span>`;
      } else if (revealed) {
        state = `<span class="chip chip-revealed">revealed</span>`;
      } else if (live?.status === 'stalled') {
        state = `<span class="chip chip-stalled">stalled</span>`;
      } else if (firesAt != null) {
        const secs = firesAt - now;
        state = secs > 0
          ? `<span class="num accent">${esc(fmtCountdown(secs))}</span>`
          : `<span class="muted">opening…</span>`;
      } else {
        state = `<span class="muted">at block</span>`;
      }
      const href = `#/s/${encodeURIComponent(s.conditionId)}/${s.ctHash}`;
      return `<tr>
        <td><a class="link" href="${href}">${esc(s.label)}</a></td>
        <td><span class="muted">${s.role === 'sent' ? 'you sealed it' : 'sealed for you'}</span></td>
        <td>${state}</td>
        <td class="muted">${esc(fmtRelative(s.addedAt))}</td>
        <td><button type="button" class="seal-forget" title="remove from this list"
                    data-forget="${esc(s.conditionId)}/${esc(s.ctHash)}">×</button></td>
      </tr>`;
    })
    .join('');
  return `<table>
    <thead><tr>
      <th>seal</th><th>who</th><th>opens</th><th>added</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function conditionsTable(conditions: ConditionSummary[]): string {
  if (conditions.length === 0) {
    return '<p class="muted">no conditions yet. seal something above to create the first one.</p>';
  }
  const rows = conditions
    .map((c) => {
      const fires =
        c.fires_at != null ? esc(fmtRelative(c.fires_at)) : '<span class="muted">at block</span>';
      const what = tagLabel(c.tag);
      return `<tr>
        <td><a class="mono link" href="#/condition/${encodeURIComponent(c.id)}">${esc(truncMiddle(c.id, 14, 6))}</a></td>
        <td>${what ? esc(what) : '<span class="muted">·</span>'}</td>
        <td>${statusChip(c.status)}</td>
        <td>${fires}</td>
        <td class="num">${c.real_count}<span class="muted"> / ${c.ciphertext_count}</span></td>
        <td class="muted">${esc(fmtRelative(c.created_at))}</td>
      </tr>`;
    })
    .join('');
  return `<table>
    <thead><tr>
      <th>condition</th><th>what</th><th>status</th><th>fires</th>
      <th>sealed</th><th>created</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
