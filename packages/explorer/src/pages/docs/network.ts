/** What the network is being used for, from its own tables. */
import type { DocsPage } from '../../docs';
import { base } from './runner';
import { esc } from '../../util';

interface TagRow {
  tag: string;
  conditions: number;
  ciphertexts: number;
  revealed: number;
  last_seen: number;
  recent: number;
}

interface Stats {
  totals: { conditions: number; revealed: number; pending: number; sealed: number; padding: number };
  recent: { conditions: number; sealed: number };
  median_open_ms: number | null;
  tags: TagRow[];
  as_of: number;
}

const nf = new Intl.NumberFormat();

function ago(unix: number, now: number): string {
  const secs = Math.max(0, now - unix);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}

export const network: DocsPage = {
  title: 'Live activity',
  lede: 'What is running on the network right now, aggregated from the coordinator’s own tables.',
  html: `
    <h2 id="the-numbers">The numbers</h2>
    <p>Straight from <code>/v1/stats</code>, refreshed every ten seconds. Nothing here is a
    figure somebody typed.</p>
    <div class="facts" id="dev-facts" aria-label="live network numbers">
      <div><span>conditions</span><strong>…</strong></div>
      <div><span>payloads sealed</span><strong>…</strong></div>
      <div><span>opened</span><strong>…</strong></div>
      <div><span>median open</span><strong>…</strong></div>
    </div>

    <h2 id="name-your-app">Name your app</h2>
    <p>Pass a <code>tag</code> when you create a round or an auction. It is how you query your
    own later, and it puts your app on the board below.</p>
    <pre class="doc-code"><code>body: JSON.stringify({ opens_in: 3600, tag: 'my-app' })</code></pre>
    <p class="dev-note">Tags are up to 32 characters of <code>a-z 0-9 : _ -</code>. They are
    labels rather than registered names, so read the board as a directory of what is being built
    on the network.</p>

    <h2 id="the-board">The board</h2>
    <p>It counts work, not people: there are no accounts here to count. The coordinator pads
    every batch with decoys, and those are excluded, so a quiet tag does not look busy.</p>
    <div id="dev-board" class="dev-board"><p class="muted">loading…</p></div>`,

  mount: (root) => {
    let timer: number | undefined;
    let stopped = false;

    const paint = (s: Stats): void => {
      const facts = root.querySelector('#dev-facts');
      if (facts) {
        const open = s.median_open_ms === null ? '—' : `${(s.median_open_ms / 1000).toFixed(1)}s`;
        facts.innerHTML = `
          <div><span>conditions</span><strong>${nf.format(s.totals.conditions)}</strong></div>
          <div><span>payloads sealed</span><strong>${nf.format(s.totals.sealed)}</strong></div>
          <div><span>opened</span><strong>${nf.format(s.totals.revealed)}</strong></div>
          <div><span>median open</span><strong>${esc(open)}</strong></div>`;
      }

      const board = root.querySelector('#dev-board');
      if (!board) return;
      if (s.tags.length === 0) {
        board.innerHTML = '<p class="muted">nobody has tagged a condition yet. be first.</p>';
        return;
      }
      const top = Math.max(1, ...s.tags.map((t) => t.conditions));
      const rows = s.tags.map((t, i) => {
        const share = Math.max(2, Math.round((t.conditions / top) * 100));
        const live = t.recent > 0;
        return `
        <li class="dev-rank${live ? ' is-live' : ''}">
          <span class="dev-rank-n mono">${i + 1}</span>
          <span class="dev-rank-tag mono">${esc(t.tag)}${live ? '<span class="dev-live">active</span>' : ''}</span>
          <span class="dev-rank-bar" aria-hidden="true"><i style="width:${share}%"></i></span>
          <span class="dev-rank-num">${nf.format(t.conditions)}</span>
          <span class="dev-rank-num">${nf.format(t.ciphertexts)}</span>
          <span class="dev-rank-when">${esc(ago(t.last_seen, s.as_of))}</span>
        </li>`;
      }).join('');
      board.innerHTML = `
        <ol class="dev-ranks">
          <li class="dev-rank dev-rank-head">
            <span class="dev-rank-n"></span><span class="dev-rank-tag">tag</span>
            <span class="dev-rank-bar"></span>
            <span class="dev-rank-num">rounds</span><span class="dev-rank-num">sealed</span>
            <span class="dev-rank-when">last</span>
          </li>${rows}
        </ol>
        <p class="field-hint">${nf.format(s.recent.conditions)} condition${s.recent.conditions === 1 ? '' : 's'}
        and ${nf.format(s.recent.sealed)} payload${s.recent.sealed === 1 ? '' : 's'} in the last 24 hours.</p>`;
    };

    /** An ellipsis reads as still loading when it means gave up. */
    const unavailable = (): void => {
      const facts = root.querySelector('#dev-facts');
      if (facts?.textContent?.includes('…')) {
        for (const strong of facts.querySelectorAll('strong')) strong.textContent = '—';
      }
      const board = root.querySelector('#dev-board');
      if (board && board.textContent?.trim() === 'loading…') {
        board.innerHTML = '<p class="muted">the network numbers are not reachable from here '
          + 'right now. they will fill in when they are.</p>';
      }
    };

    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`${base}/v0/stats`, { headers: { accept: 'application/json' } });
        // A dev server with no coordinator behind it answers with the app shell,
        // so a 200 is not on its own proof of an answer.
        if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) {
          throw new Error(`stats unavailable (${res.status})`);
        }
        const body = (await res.json()) as Stats;
        if (typeof body?.totals?.conditions !== 'number') throw new Error('unexpected shape');
        paint(body);
      } catch {
        unavailable();
      }
      if (!stopped) timer = window.setTimeout(poll, 10_000);
    };
    void poll();

    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  },
};
