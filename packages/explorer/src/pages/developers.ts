/** The developer section: how to build on Peal without using any of our pages.
 *
 * Written to be USED rather than admired, so every example on it runs against
 * the live coordinator from the page itself. A code sample nobody has executed
 * is a claim; one with a Run button beside it and the real response underneath
 * is a demonstration, and the difference matters most for a network whose whole
 * proposition is "this actually opens on time".
 *
 * The numbers are the same: they come from /v0/stats, which aggregates the
 * coordinator's own tables. Nothing on this page is a figure somebody typed.
 */
import { BteClient } from 'bte-sdk';
import { API_BASE } from '../api';
import { mountScrollReveal } from '../reveal';
import { esc } from '../util';

const sections = [
  ['start', 'Quickstart'],
  ['calls', 'The three calls'],
  ['uses', 'What to build'],
  ['reference', 'API reference'],
  ['identify', 'Name your app'],
  ['board', 'Live leaderboard'],
  ['limits', 'Limits and trust'],
] as const;

interface TagRow {
  tag: string;
  conditions: number;
  ciphertexts: number;
  revealed: number;
  first_seen: number;
  last_seen: number;
  recent: number;
}

interface Stats {
  totals: { conditions: number; revealed: number; pending: number; sealed: number; padding: number };
  recent: { conditions: number; sealed: number };
  window_secs: number;
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

/** One runnable example. The code shown is the code that runs: the button calls
 * `run`, and what comes back is printed verbatim rather than summarised. */
interface Demo {
  id: string;
  title: string;
  note: string;
  code: string;
  run: (log: (line: string) => void, state: DemoState) => Promise<void>;
}

interface DemoState {
  conditionId?: string;
  ctHash?: string;
}

function demoHtml(d: Demo): string {
  return `
    <div class="dev-demo" data-demo="${esc(d.id)}">
      <div class="dev-demo-head">
        <h4>${esc(d.title)}</h4>
        <button class="btn dev-run" type="button" data-run="${esc(d.id)}">run it</button>
      </div>
      <p class="dev-note">${d.note}</p>
      <pre class="dev-code"><code>${esc(d.code)}</code></pre>
      <pre class="dev-out" data-out="${esc(d.id)}" hidden></pre>
    </div>`;
}

export function renderDevelopers(root: HTMLElement): () => void {
  const previousTitle = document.title;
  document.title = 'Build on Peal. seal now, opens on cue.';

  // Two different things, and conflating them would ship broken documentation.
  // API_BASE is empty in production because this page is served from the same
  // origin as the coordinator, which is right for OUR fetches and wrong for
  // every sample on the page: somebody pasting `fetch('/v0/conditions')` into
  // their own app would be calling their own server. Samples get an absolute
  // URL; the calls this page makes keep using the relative one.
  const base = API_BASE.replace(/\/$/, '');
  const shown = base || window.location.origin;
  const client = new BteClient({ url: base });
  const shared: DemoState = {};

  const demos: Demo[] = [
    {
      id: 'condition',
      title: '1. Say when it opens',
      note: `A condition is the cue. Nothing is encrypted yet: this only names the moment.
             Plain HTTP, no key, no wallet, works from curl.`,
      code: `const res = await fetch('${shown}/v0/conditions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ in_secs: 60, tag: 'my-app' }),
});
const { id } = await res.json();`,
      run: async (log, state) => {
        const res = await fetch(`${base}/v0/conditions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ in_secs: 60, tag: 'docs:try' }),
        });
        const body = (await res.json()) as { id?: string };
        log(JSON.stringify(body, null, 2));
        if (body.id) {
          state.conditionId = body.id;
          log(`\nkept as the condition for step 2.`);
        }
      },
    },
    {
      id: 'seal',
      title: '2. Seal something to it',
      note: `This one needs the library, because the encryption happens on your side. That is the
             point: the payload is unreadable before it leaves the page, so there is no moment
             where we could read it even if we wanted to.`,
      code: `import { BteClient } from 'bte-sdk';

const peal = new BteClient({ url: '${shown}' });
const { ctHash } = await peal.seal('my secret', id);`,
      run: async (log, state) => {
        if (!state.conditionId) {
          log('run step 1 first: this needs a condition to seal to.');
          return;
        }
        const secret = `sealed from the docs at ${new Date().toISOString()}`;
        log(`sealing: ${secret}\n`);
        const { ctHash, sealedB64 } = await client.seal(secret, state.conditionId);
        state.ctHash = ctHash;
        log(`ct_hash: ${ctHash}`);
        log(`sealed:  ${sealedB64.slice(0, 64)}… (${sealedB64.length} base64 chars)`);
        log(`\nthat ciphertext is now on the coordinator and nobody can read it,`);
        log(`including the operators, until the condition fires.`);
      },
    },
    {
      id: 'read',
      title: '3. Read it when it opens',
      note: `Before the cue this returns nothing at all, which is the guarantee working. After it,
             the whole batch is public in one response. Plain HTTP again.`,
      code: `const res = await fetch(\`${shown}/v0/reveals/\${id}\`);
// 404 until the cue fires, then every payload in the batch at once.
const reveal = await res.json();`,
      run: async (log, state) => {
        const id = state.conditionId;
        if (!id) {
          log('run step 1 first.');
          return;
        }
        const res = await fetch(`${base}/v0/reveals/${encodeURIComponent(id)}`);
        if (res.status === 404) {
          const status = await fetch(`${base}/v0/conditions/${encodeURIComponent(id)}`);
          const cond = (await status.json()) as { status?: string; fires_at?: number };
          const left = cond.fires_at ? cond.fires_at - Math.floor(Date.now() / 1000) : null;
          log(`404, and that is the answer working.`);
          log(`condition is "${cond.status}"${left !== null && left > 0 ? `, opens in ${left}s` : ''}.`);
          log(`\nnothing readable exists yet. try this again after the cue.`);
          return;
        }
        const reveal = (await res.json()) as { slots?: { payload_b64: string; is_dummy: boolean }[] };
        const real = (reveal.slots ?? []).filter((s) => !s.is_dummy);
        log(`opened: ${real.length} real payload${real.length === 1 ? '' : 's'} `
          + `(+${(reveal.slots ?? []).length - real.length} decoys the coordinator added)`);
        for (const s of real.slice(0, 5)) {
          try {
            log(`  ${new TextDecoder().decode(Uint8Array.from(atob(s.payload_b64), (c) => c.charCodeAt(0)))}`);
          } catch {
            log('  (binary payload)');
          }
        }
      },
    },
  ];

  root.innerHTML = `
    <article class="protocol-article dev-article">
      <header id="start" class="scroll-reveal">
        <p class="kicker">Peal for developers · v0</p>
        <h1>Seal it now. It opens on cue, for everyone at once.</h1>
        <p class="lede">Peal is encryption you can put a clock on. Your users seal something, nobody
        can read it (not them, not you, not us), and at the moment you named it opens by itself
        for everybody at the same time. No second transaction, no one who gets to peek first, no
        trusted middleman holding the key until then.</p>
        <p class="lede">It is three HTTP calls. There is no signup, no API key and no payment, and
        every example on this page runs against the live network from your browser.</p>
        <div class="facts" id="dev-facts" aria-label="live network numbers">
          <div><span>conditions</span><strong>…</strong></div>
          <div><span>payloads sealed</span><strong>…</strong></div>
          <div><span>opened</span><strong>…</strong></div>
          <div><span>median open</span><strong>…</strong></div>
        </div>
      </header>

      <nav class="protocol-nav" aria-label="developer sections">
        ${sections.map(([id, label], i) =>
          `<button type="button" data-section="${id}"${i === 0 ? ' aria-current="true"' : ''}>${label}</button>`).join('')}
      </nav>

      <section id="calls" class="scroll-reveal">
        <h2>The three calls</h2>
        <p>Run them in order. Step one and three are ordinary HTTP that curl can do; step two needs
        the library, because that is where your data actually gets encrypted.</p>
        ${demos.map(demoHtml).join('')}
      </section>

      <section id="uses" class="scroll-reveal">
        <h2>What to build</h2>
        <p>The shape is always the same: people commit to something they cannot take back, and
        nobody can see anyone else's until they all open together. That turns out to be the
        missing piece in a lot of things.</p>
        <div class="dev-uses">
          <div class="dev-use">
            <h3>Sealed bid auctions</h3>
            <p>Everyone bids blind, all bids open at the close. Nobody can watch the leader and
            top it by a dollar in the last second, because there is nothing to watch.</p>
            <p class="dev-use-how"><code>tag: 'auction:&lt;id&gt;'</code> · one condition per
            auction, one seal per bid</p>
          </div>
          <div class="dev-use">
            <h3>Encrypted mempools</h3>
            <p>Transactions seal to the block they belong in, so a searcher cannot read the queue
            and jump it. The whole block's worth opens at once when the block is due.</p>
            <p class="dev-use-how"><code>kind: 'at_block'</code> · a condition per block height</p>
          </div>
          <div class="dev-use">
            <h3>Commit and reveal, without the reveal</h3>
            <p>Every commit-reveal game has the same bug: whoever moves last can just not reveal
            when they see they have lost. Here the reveal is not their move to make.</p>
            <p class="dev-use-how"><code>tag: 'game:&lt;round&gt;'</code> · a condition per round</p>
          </div>
          <div class="dev-use">
            <h3>Votes that cannot be swayed</h3>
            <p>Nobody sees a running tally, so nobody votes strategically off the back of one, and
            no early voter is influenced by a late one.</p>
            <p class="dev-use-how"><code>tag: 'vote:&lt;proposal&gt;'</code> · one condition per poll</p>
          </div>
          <div class="dev-use">
            <h3>Embargoes that hold themselves</h3>
            <p>Earnings, a security disclosure, a paper under embargo. Send it to everyone now, in
            a form nobody can open early, and it publishes itself at the hour.</p>
            <p class="dev-use-how"><code>fires_at</code> · an absolute unix second</p>
          </div>
          <div class="dev-use">
            <h3>Anything with a deadline</h3>
            <p>Sealed bids on a tender, exam papers, a dead man's switch, a time capsule. If the
            rule is "not before this moment, and then everybody at once", it fits.</p>
            <p class="dev-use-how"><code>in_secs</code> · relative, for anything short lived</p>
          </div>
        </div>
      </section>

      <section id="reference" class="scroll-reveal">
        <h2>API reference</h2>
        <p>Base URL <code>${esc(shown)}</code>. Everything is JSON. Nothing here needs a key.</p>
        <div class="dev-endpoints">
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb dev-post">POST</span> <code>/v0/conditions</code></p>
            <p>Name a moment. <code>in_secs</code> for relative or <code>fires_at</code> for an
            absolute unix second; <code>kind: "at_block"</code> with <code>chain_id</code> and
            <code>height</code> to fire on a block instead. <code>tag</code> is your app's label.
            Returns <code>{ id }</code>.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb dev-post">POST</span> <code>/v0/ciphertexts</code></p>
            <p>Hand over an already-encrypted payload: <code>{ condition_id, sealed_blob_b64 }</code>.
            It is validated properly (parsed, on curve, subgroup checked) and refused if it is not a
            real ciphertext. Returns <code>{ ct_hash, code }</code>.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v0/reveals/{id}</code></p>
            <p>404 until the cue fires; after it, every payload in the batch with its position and
            a merkle root over the set. The decoys are flagged <code>is_dummy</code>.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v0/conditions/{id}</code></p>
            <p>Where a condition is up to: <code>pending</code>, <code>frozen</code>,
            <code>revealed</code> or <code>stalled</code>, with its batches and their timings.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v0/committees/{id}</code></p>
            <p>The public parameters you encrypt against, with a digest. The SDK checks that digest
            against the params it was served, so a coordinator handing out inconsistent parameters
            fails loudly instead of quietly.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v0/stats</code></p>
            <p>What the network is being used for, aggregated over every condition rather than the
            last hundred. This page's numbers and the board below are this endpoint.</p>
          </div>
        </div>
      </section>

      <section id="identify" class="scroll-reveal">
        <h2>Name your app</h2>
        <p>Pass a <code>tag</code> when you create a condition and your app appears on the board
        below. The coordinator does not interpret it: it is there so you can find your own
        conditions, and so anyone can see what is being built.</p>
        <pre class="dev-code"><code>body: JSON.stringify({ in_secs: 60, tag: 'my-app' })</code></pre>
        <p class="dev-caveat">A tag is a claim, not a credential. There are no accounts here, so
        anyone can send any label including one already on the board. Read it as a directory of
        what is being built, not a ranking with anything staked on it.</p>
      </section>

      <section id="board" class="scroll-reveal">
        <h2>Live leaderboard</h2>
        <p>Straight from the coordinator's own tables, refreshed every ten seconds. It counts work,
        not people: there are no accounts to count.</p>
        <div id="dev-board" class="dev-board"><p class="muted">loading…</p></div>
      </section>

      <section id="limits" class="scroll-reveal">
        <h2>Limits and trust</h2>
        <p>The parts worth knowing before you put something real on this.</p>
        <div class="dev-limits">
          <div><span>payload</span><strong>5 MB</strong><p>Per sealed blob.</p></div>
          <div><span>rate</span><strong>50/s</strong><p>Per IP, bursting to 400.</p></div>
          <div><span>batch</span><strong>64</strong><p>Padded with decoys, so a quiet condition
          does not announce how few sealed to it.</p></div>
          <div><span>committee</span><strong>3 of 5</strong><p>Any three operators can open a
          batch. Any two cannot.</p></div>
        </div>
        <p class="dev-caveat"><strong>This is a devnet, and the honest version of the trust model
        matters more than the pitch.</strong> The committee keys came from a trusted dealer, not a
        distributed key generation, so at setup one machine knew everything. Three of the five
        operators working together can open a batch early, and today they are not five independent
        parties. What the cryptography gives you is that no fewer than three can, and that a
        reveal, once it happens, is verifiable by anyone. What it does not give you yet is
        protection from us. Build accordingly, and read the
        <a href="#/protocol">protocol reference</a> before you decide what to trust it with.</p>
      </section>
    </article>`;

  // ---- live numbers and the board ----
  let timer: number | undefined;
  let stopped = false;

  const paintStats = (s: Stats): void => {
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
    const rows = s.tags.map((t, i) => `
      <li class="dev-rank">
        <span class="dev-rank-n mono">${i + 1}</span>
        <span class="dev-rank-tag mono">${esc(t.tag)}</span>
        <span class="dev-rank-num" title="conditions created">${nf.format(t.conditions)}</span>
        <span class="dev-rank-num" title="payloads sealed by callers">${nf.format(t.ciphertexts)}</span>
        <span class="dev-rank-when">${esc(ago(t.last_seen, s.as_of))}</span>
      </li>`).join('');
    board.innerHTML = `
      <ol class="dev-ranks">
        <li class="dev-rank dev-rank-head">
          <span class="dev-rank-n"></span><span class="dev-rank-tag">tag</span>
          <span class="dev-rank-num">conditions</span><span class="dev-rank-num">sealed</span>
          <span class="dev-rank-when">last</span>
        </li>
        ${rows}
      </ol>
      <p class="field-hint">${nf.format(s.recent.conditions)} condition${s.recent.conditions === 1 ? '' : 's'}
      and ${nf.format(s.recent.sealed)} payload${s.recent.sealed === 1 ? '' : 's'} in the last 24 hours.</p>`;
  };

  const poll = async (): Promise<void> => {
    try {
      const res = await fetch(`${base}/v0/stats`);
      if (res.ok) paintStats((await res.json()) as Stats);
    } catch {
      // A leaderboard is not worth an error banner. It fills in on the next tick.
    }
    if (!stopped) timer = window.setTimeout(poll, 10_000);
  };
  void poll();

  // ---- the runnable examples ----
  root.querySelectorAll<HTMLButtonElement>('.dev-run').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.run;
      const demo = demos.find((d) => d.id === id);
      const out = root.querySelector<HTMLElement>(`[data-out="${id}"]`);
      if (!demo || !out) return;

      out.hidden = false;
      out.textContent = '';
      btn.disabled = true;
      btn.textContent = 'running…';
      const log = (line: string): void => {
        out.textContent = `${out.textContent}${line}\n`;
      };
      try {
        await demo.run(log, shared);
      } catch (e) {
        log(`failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        btn.disabled = false;
        btn.textContent = 'run it';
      }
    });
  });

  const stopReveal = mountScrollReveal(root);
  return () => {
    stopped = true;
    if (timer) window.clearTimeout(timer);
    stopReveal();
    document.title = previousTitle;
  };
}
