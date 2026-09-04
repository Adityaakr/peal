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
import { Peal } from '../../embed/peal';
import { API_BASE } from '../api';
import { mountScrollReveal } from '../reveal';
import { esc } from '../util';

const sections = [
  ['start', 'Start here'],
  ['how', 'How it works'],
  ['calls', 'The three calls'],
  ['uses', 'What to build'],
  ['reference', 'API reference'],
  ['next', 'Peal Commit'],
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

/**
 * Read a response, or say what actually went wrong.
 *
 * `res.json()` on an empty body throws "unexpected end of JSON input", which
 * tells a reader nothing about the cause: a 404 from a dev proxy that does not
 * forward the route and a 405 from a static file server both look like that.
 * The status and the content type are the diagnosis, so they go in the message.
 */
async function readJson(res: Response, what: string): Promise<unknown> {
  const type = res.headers.get('content-type') ?? '';
  const body = await res.text();
  if (!body.trim()) {
    throw new Error(
      `${what} returned ${res.status} with an empty body.`
      + (res.status === 404 || res.status === 405
        ? ' this build is talking to a server that does not serve /v1 yet.'
        : ''),
    );
  }
  if (!type.includes('json')) {
    throw new Error(`${what} returned ${res.status} as ${type || 'an unknown type'}, not JSON.`);
  }
  return JSON.parse(body);
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
  const client = new Peal({ url: base });
  const shared: DemoState = {};

  const demos: Demo[] = [
    {
      id: 'round',
      title: '1. Open a round',
      note: `A round is a moment and everything sealed to it. Nothing is encrypted yet.
             <code>opens_in</code> is relative; <code>opens_at</code> takes RFC 3339 or unix
             seconds; <code>opens_at_block</code> takes a chain height. Plain HTTP, no key, works
             from curl.`,
      code: `const res = await fetch('${shown}/v1/rounds', {
  method: 'POST',
  headers: { 'content-type': 'application/json',
             'idempotency-key': crypto.randomUUID() },
  body: JSON.stringify({
    opens_in: 3600,
    tag: 'my-app',
    title: 'Signed tour poster',
    description: 'One of a kind, ships worldwide.',
    image_url: 'https://images.example.com/poster.jpg',
  }),
});
const round = await res.json();   // { id, status: 'open', title, image_url, … }`,
      run: async (log, state) => {
        const res = await fetch(`${base}/v1/rounds`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({
            opens_in: 60,
            tag: 'docs:try',
            title: 'Signed tour poster',
            description: 'One of a kind, ships worldwide.',
            image_url: 'https://images.example.com/poster.jpg',
          }),
        });
        const body = (await readJson(res, 'POST /v1/rounds')) as { id?: string };
        log(JSON.stringify(body, null, 2));
        if (body.id) {
          state.conditionId = body.id;
          log(`\nkept as the round for step 2.`);
        }
      },
    },
    {
      id: 'seal',
      title: '2. Seal a payload to it',
      note: `The only step that needs code, because this is where the encryption happens and it
             happens on your machine. <code>peal.js</code> loads straight from this domain: one
             file, nothing to install. It fetches the public parameters, checks their digest
             against what it was served, encrypts locally and posts the ciphertext. The seal's id
             is the SHA-256 of that ciphertext, so you can compute it yourself.`,
      code: `import { peal } from '${shown}/peal.js';

const seal = await peal.seal('my secret', round.id);
// seal.id === sha256(ciphertext), computable without trusting us`,
      run: async (log, state) => {
        if (!state.conditionId) {
          log('run step 1 first: this needs a round to seal to.');
          return;
        }
        const secret = `sealed from the docs at ${new Date().toISOString()}`;
        log(`sealing: ${secret}\n`);
        const sealed = await client.seal(secret, state.conditionId);
        state.ctHash = sealed.id;
        log(JSON.stringify(sealed, null, 2));
        log(`\nunreadable from here until the round opens.`);
      },
    },
    {
      id: 'read',
      title: '3. Read the round',
      note: `One URL, every stage, always 200. While the round is open you get a status and a
             count; once it opens the same call reports <code>opened</code> and the payloads are
             available. Send <code>If-None-Match</code> with the ETag and you get 304s while you
             wait, so polling a deadline costs almost nothing.`,
      code: `const round = await (await fetch(\`${shown}/v1/rounds/\${id}\`)).json();
if (round.status === 'opened') {
  const { data } = await (await fetch(\`${shown}/v1/rounds/\${id}/seals\`)).json();
  // each entry now carries payload_b64
}`,
      run: async (log, state) => {
        const id = state.conditionId;
        if (!id) {
          log('run step 1 first.');
          return;
        }
        const res = await fetch(`${base}/v1/rounds/${encodeURIComponent(id)}`);
        const round = (await readJson(res, 'GET /v1/rounds/{id}')) as {
          status?: string; seals?: number; opens_at_unix?: number; slots_including_decoys?: number;
        };
        log(JSON.stringify(round, null, 2));
        const etag = res.headers.get('etag');
        if (etag) log(`\netag: ${etag}  (send If-None-Match to poll for free)`);

        if (round.status !== 'opened') {
          const left = round.opens_at_unix
            ? round.opens_at_unix - Math.floor(Date.now() / 1000)
            : null;
          log(`\nstill ${round.status}${left && left > 0 ? `, opens in ${left}s` : ''}.`);
          log(`no payload exists yet. run this again after it opens.`);
          return;
        }
        const seals = await client.listSeals(id);
        log(`\n${seals.length} seal${seals.length === 1 ? '' : 's'}:`);
        for (const s of seals.slice(0, 5)) {
          const text = s.payload_b64
            ? new TextDecoder().decode(Uint8Array.from(atob(s.payload_b64), (c) => c.charCodeAt(0)))
            : '(sealed)';
          log(`  ${s.id.slice(0, 12)}…  ${text}`);
        }
      },
    },
  ];

  root.innerHTML = `
    <article class="protocol-article dev-article">
      <header id="start" class="scroll-reveal">
        <p class="kicker">Peal for developers · API v0</p>
        <h1>Private submissions. Programmable reveal.</h1>
        <p class="lede">Peal is one API for collecting encrypted bids, offers, votes and
        commitments, then opening them only when the rules say. Everything arrives sealed, nothing
        is readable before the deadline (not by the other participants, not by you, not by us), and
        when the moment comes the whole set opens at once.</p>

        <p class="lede"><strong>If your product has a deadline, it probably has this bug.</strong>
        Anywhere people submit something that others must not see yet, whoever runs the server can
        see it. You can promise you do not look. You cannot prove it, and your users cannot check.
        That single fact is why sealed bids get run over email, why fair launches get front run,
        and why every commit-reveal scheme leaks a way for the loser to simply never reveal.</p>

        <p class="lede">The hard part was never the encryption. It is that somebody has to hold the
        key until the deadline, and whoever holds it can peek, leak, or quietly decline to open it
        when the answer does not suit them. Peal removes that person. No single party can open a
        batch early, and nobody has to come back to reveal, because the network does it on its
        own.</p>

        <p class="lede">What you add is three HTTP calls. No signup, no API key, no wallet and no
        gas for the people submitting. Every example below runs against the live network from this
        page, so you can see it work before you write anything.</p>

        <pre class="dev-code dev-teaser"><code>import { peal } from '${shown}/peal.js';

const { id } = await peal.createCondition({ in_secs: 3600, tag: 'my-app' });
await peal.seal(userSubmission, id);       // encrypted here, unreadable from now on
const payloads = await peal.getPayloads(id);  // all of them, at the deadline</code></pre>
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

      <section id="how" class="scroll-reveal">
        <h2>How it works</h2>
        <p>Your app encrypts locally and sends a ciphertext. The coordinator stores it and holds no
        key that opens it. When the moment arrives, three of the five operators open the whole
        batch at once, and everyone reads the same result.</p>

        <figure class="dev-figure">
          <svg viewBox="0 0 920 352" role="img" class="sketch"
               aria-label="Your app encrypts a payload locally and sends only ciphertext to the coordinator, which stores it unreadable until the condition fires, when three of five operators open the whole batch at once for everyone.">
            <defs>
              <marker id="dv-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                      markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M0.5 1 L9 5 L0.5 9" fill="none" stroke="currentColor"
                      stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </marker>
            </defs>

            <!-- 1. your app -->
            <g class="sk-node">
              <path class="sk-box sk-box-you"
                    d="M18 46 q -2 -12 10 -13 l 200 -2 q 12 0 12.5 11 l 1 118 q 0 12 -11 12.5 l -201 1.5 q -12 0 -12.5 -11 z" />
              <text class="sk-title" x="42" y="78">your app or agent</text>
              <text class="sk-line" x="42" y="104">bid, vote, quote, forecast</text>
              <text class="sk-strong" x="42" y="130">encrypted here</text>
              <text class="sk-line" x="42" y="152">plaintext never leaves</text>
            </g>

            <!-- 2. coordinator -->
            <g class="sk-node">
              <path class="sk-box"
                    d="M348 46 q -2 -12 10 -13 l 218 -2 q 12 0 12.5 11 l 1 118 q 0 12 -11 12.5 l -219 1.5 q -12 0 -12.5 -11 z" />
              <text class="sk-title" x="372" y="78">coordinator</text>
              <text class="sk-line" x="372" y="104">holds ciphertexts only</text>
              <text class="sk-line" x="372" y="126">no key that opens one</text>
              <text class="sk-line" x="372" y="152">batch of 64, padded with decoys</text>
            </g>

            <!-- 3. committee -->
            <g class="sk-node">
              <path class="sk-box"
                    d="M700 46 q -2 -12 10 -13 l 190 -2 q 12 0 12.5 11 l 1 118 q 0 12 -11 12.5 l -191 1.5 q -12 0 -12.5 -11 z" />
              <text class="sk-title" x="724" y="78">5 operators</text>
              <text class="sk-line" x="724" y="104">any 3 can open</text>
              <text class="sk-line" x="724" y="126">any 2 cannot</text>
              <g class="sk-dots">
                <circle cx="732" cy="150" r="7" class="sk-on" />
                <circle cx="754" cy="150" r="7" class="sk-on" />
                <circle cx="776" cy="150" r="7" class="sk-on" />
                <circle cx="798" cy="150" r="7" />
                <circle cx="820" cy="150" r="7" />
              </g>
            </g>

            <!-- arrows across the top row -->
            <path class="sk-arrow" marker-end="url(#dv-arrow)" d="M244 108 q 44 -8 96 0" />
            <text class="sk-tag" x="252" y="94">ciphertext</text>
            <path class="sk-arrow" marker-end="url(#dv-arrow)" d="M596 108 q 46 -8 96 0" />
            <text class="sk-tag" x="604" y="94">shares</text>

            <!-- Everything from sealing until the cue is unreadable. Labelled to
                 the left of the drop line so nothing crosses the words. -->
            <path class="sk-brace" d="M40 206 q 200 12 384 2" />
            <text class="sk-tag sk-end" x="424" y="232">unreadable by anyone, including us</text>

            <!-- the condition, underneath -->
            <path class="sk-arrow sk-dash" d="M469 180 L469 226" marker-end="url(#dv-arrow)" />
            <g class="sk-node">
              <path class="sk-box sk-box-cue"
                    d="M334 264 q -2 -12 10 -13 l 250 -2 q 12 0 12.5 11 l 1 58 q 0 12 -11 12.5 l -251 1.5 q -12 0 -12.5 -11 z" />
              <text class="sk-title" x="358" y="298">the condition fires</text>
              <text class="sk-line" x="358" y="320">a time, or a block height</text>
            </g>

            <!-- reveal -->
            <path class="sk-arrow" d="M614 290 L710 290" marker-end="url(#dv-arrow)" />
            <g class="sk-node">
              <path class="sk-box sk-box-open"
                    d="M716 256 q -2 -12 10 -13 l 174 -2 q 12 0 12.5 11 l 1 74 q 0 12 -11 12.5 l -175 1.5 q -12 0 -12.5 -11 z" />
              <text class="sk-title" x="740" y="290">everything opens</text>
              <text class="sk-line" x="740" y="312">at once, for everyone</text>
              <text class="sk-line" x="740" y="332">merkle root over the set</text>
            </g>
          </svg>
          <figcaption>Encryption happens in your process. Nothing between it and the deadline can
          read the payload, and opening it takes three operators acting together.</figcaption>
        </figure>

        <div class="dev-life">
          <div class="dev-life-step is-now">
            <span class="dev-pill dev-pill-open">open</span>
            <p>Anyone can seal. Nothing is readable, including the count of what is inside.</p>
          </div>
          <div class="dev-life-step">
            <span class="dev-pill dev-pill-closing">closing</span>
            <p>The deadline passed. The batch is frozen and padded; operators are producing
            shares.</p>
          </div>
          <div class="dev-life-step">
            <span class="dev-pill dev-pill-opened">opened</span>
            <p>Every payload is public in the same instant, with a merkle root over the set.</p>
          </div>
        </div>

        <p>A round can also say what it is, so somebody deciding whether to take part can see it
        before anything opens. That part is public from the moment the round exists, which is
        exactly the opposite of the payloads sealed to it:</p>

        <div class="dev-roundcard">
          <div class="dev-roundcard-img" aria-hidden="true">
            <svg viewBox="0 0 120 96"><rect width="120" height="96" rx="8" />
              <path d="M14 74 L44 40 L66 62 L84 48 L106 74 Z" class="dev-roundcard-hill" />
              <circle cx="88" cy="28" r="9" class="dev-roundcard-sun" />
            </svg>
            <span>image_url</span>
          </div>
          <div class="dev-roundcard-body">
            <p class="dev-roundcard-title">Signed tour poster <span class="dev-pill dev-pill-open">open</span></p>
            <p class="dev-roundcard-desc">One of a kind, ships worldwide.</p>
            <p class="dev-roundcard-meta"><code>opens_at</code> 2026-09-12T18:00:00Z ·
            <code>seals</code> 14 · <code>tag</code> my-app</p>
          </div>
        </div>

        <p>Two details worth knowing. Every batch is padded to 64 with decoys the coordinator seals
        to itself, so a round with three submissions does not announce that it had three; decoys
        come back flagged <code>is_dummy</code>. And slot positions are derived from the ciphertext
        hashes rather than arrival order, so a batch cannot be reordered after the fact.</p>
      </section>

      <section id="calls" class="scroll-reveal">
        <h2>The three calls</h2>
        <p>Run them in order. Step one and three are ordinary HTTP that curl can do; step two needs
        the library, because that is where your data actually gets encrypted.</p>
        ${demos.map(demoHtml).join('')}
      </section>

      <section id="uses" class="scroll-reveal">
        <h2>What to build</h2>
        <p>The shape is always the same: people commit to something they cannot take back, and
        nobody can see anyone else's until they all open together. That turns out to be the missing
        piece in a lot of things.</p>

        <div class="dev-headline">
          <p class="dev-headline-kicker">the one we most want built</p>
          <h3>Sealed actions for autonomous agents, paid per call</h3>
          <p><strong>A pay-per-use API that lets agents seal an action, bid, prediction or message
          until a deadline, then automatically reveal it with cryptographic proof.</strong></p>
          <p>Agents are the users who need this most and can integrate it fastest. An agent that
          submits in the clear can be read and front run by the next agent in the queue. An agent
          cannot sign up for your service, accept terms, or hold an API key it did not earn, but it
          can pay for one request. So the natural shape is a single priced call: seal this until
          then, and prove afterwards that nobody could have touched it.</p>
          <p>Peal supplies the part nobody can build for themselves, which is the evidence that no
          one could peek, copy, alter or open early. <a href="https://docs.x402.org/introduction"
          target="_blank" rel="noopener">x402</a> supplies payment and discovery without an
          account. <button type="button" class="dev-jump" data-section="next">The API shape and
          pricing are below</button>. The primitive they are built on is live and running
          the examples on this page today.</p>
        </div>

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
            <p>No running tally means no bandwagon and no strategic vote cast off the back of one.
            Early voters do not influence late ones because there is nothing to see.</p>
            <p class="dev-use-how"><code>tag: 'vote:&lt;proposal&gt;'</code> · one condition per poll</p>
          </div>
          <div class="dev-use">
            <h3>Agent bids and actions</h3>
            <p>An autonomous agent that submits in the clear can be front-run by another agent
            reading the same queue. Sealing the action means a machine can commit to something it
            cannot secretly alter, and cannot reveal early to gain an edge.</p>
            <p class="dev-use-how"><code>tag: 'agent:&lt;swarm&gt;'</code> · one condition per round</p>
          </div>
          <div class="dev-use">
            <h3>Procurement and quotes</h3>
            <p>Suppliers quote blind. Nobody undercuts a number they were not supposed to see, and
            the buyer cannot shop one supplier's price to another before the close.</p>
            <p class="dev-use-how"><code>tag: 'rfq:&lt;tender&gt;'</code> · quotes as payloads</p>
          </div>
          <div class="dev-use">
            <h3>Prediction tournaments</h3>
            <p>Every forecast is sealed until the window shuts, so nobody copies a better
            forecaster and nobody edits after the fact. The scoreboard is computable by anyone from
            the reveal.</p>
            <p class="dev-use-how"><code>tag: 'round:&lt;n&gt;'</code> · one condition per window</p>
          </div>
          <div class="dev-use">
            <h3>Bounty and grant submissions</h3>
            <p>Entries open together at the deadline, so a late entrant cannot read the field and
            beat it by a nose, and a reviewer cannot leak one entry to another team.</p>
            <p class="dev-use-how"><code>fires_at</code> · the deadline, as a unix second</p>
          </div>
          <div class="dev-use">
            <h3>Token allocations and fair launches</h3>
            <p>A private order book that opens all at once and clears at one price. No visible
            order flow to trade against, and no allocator advantage from seeing the book first.</p>
            <p class="dev-use-how"><code>tag: 'sale:&lt;id&gt;'</code> · orders as payloads</p>
          </div>
          <div class="dev-use">
            <h3>Embargoes that hold themselves</h3>
            <p>Earnings, a security disclosure, a paper under embargo. Distribute it now in a form
            nobody can open early, and it publishes itself on the hour.</p>
            <p class="dev-use-how"><code>fires_at</code> · an absolute unix second</p>
          </div>
          <div class="dev-use">
            <h3>Anything with a deadline</h3>
            <p>Exam papers, a dead man's switch, a scheduled disclosure, a time capsule. If the rule
            is "not before this moment, and then everybody at once", it fits.</p>
            <p class="dev-use-how"><code>in_secs</code> · relative, for anything short lived</p>
          </div>
        </div>
      </section>

      <section id="reference" class="scroll-reveal">
        <h2>API reference</h2>
        <p>Base URL <code>${esc(shown)}</code>. Everything is JSON. Nothing here needs a key.</p>
        <div class="dev-endpoints">
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb dev-post">POST</span> <code>/v1/rounds</code></p>
            <p>Open a round. One of <code>opens_in</code> (seconds), <code>opens_at</code> (RFC 3339
            or unix seconds) or <code>opens_at_block</code> (<code>chain_id</code> +
            <code>height</code>), plus an optional <code>tag</code>. <code>title</code>,
            <code>description</code> and <code>image_url</code> describe the round publicly and
            come back on every read, including the list, so a gallery needs one request rather than
            one per tile. <code>image_url</code> must be https. Send an
            <code>Idempotency-Key</code> header and a retry returns the same round with 200 instead
            of creating a second one. 201 and a <code>Location</code> on success.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v1/rounds</code></p>
            <p>Your rounds, newest first. Filter with <code>tag</code> and <code>status</code>
            (<code>open</code>, <code>closing</code>, <code>opened</code>, <code>stalled</code>),
            page with <code>limit</code> and <code>cursor</code>. Returns
            <code>{ data, next_cursor, has_more }</code>.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v1/rounds/{id}</code></p>
            <p>One round at any stage, always 200, with <code>status</code>, <code>seals</code>,
            <code>opens_at</code> and <code>opened_at</code>. Carries an <code>ETag</code>: send
            <code>If-None-Match</code> while you wait and get 304s until something changes.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb dev-post">POST</span> <code>/v1/rounds/{id}/seals</code></p>
            <p>Submit a ciphertext: <code>{ ciphertext_b64 }</code>. Parsed, on curve and subgroup
            checked before it is stored. The seal's <code>id</code> is the SHA-256 of the
            ciphertext, so the same submission twice is the same seal and needs no idempotency key.
            409 once the round has closed.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v1/rounds/{id}/seals</code></p>
            <p>Every seal in the round. Ids and positions while it is open; the same shape with
            <code>payload_b64</code> filled in once it has opened.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v1/seals/{id}</code></p>
            <p>One seal, with its payload once the round has opened.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb dev-post">POST</span> <code>/v1/seals</code></p>
            <p>One payload, one deadline, one call: <code>{ ciphertext_b64, unlock_at }</code> or
            <code>unlock_in</code>, plus an optional <code>tag</code> and <code>title</code>.
            Creates a round holding just this seal and returns its id and a proof URL. Validated by
            the same code as the two-step form, so no rule can hold on one and not the other.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v1/seals/{id}/proof</code></p>
            <p>What can be checked: the ordering root and when it was committed, the merkle root,
            the position, and whether the commitment preceded the reveal. Null rather than false
            before the round opens.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v1/parameters</code></p>
            <p>The public key material to encrypt against, with the digest a client checks before
            using it, plus <code>operators</code>, <code>threshold</code> and
            <code>batch_size</code>.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb">GET</span> <code>/v1</code></p>
            <p>What this deployment accepts: payload cap, page sizes, rate limits, idempotency
            window. Read it rather than hard-coding limits from prose.</p>
          </div>
          <div class="dev-ep">
            <p class="dev-ep-sig"><span class="dev-verb dev-file">FILE</span> <code>/peal.js</code></p>
            <p>The client as one ES module with the encryption compiled in:
            <code>createRound</code>, <code>seal</code>, <code>getRound</code>,
            <code>listRounds</code>, <code>listSeals</code>, <code>getSeal</code>,
            <code>getPayloads</code>, <code>waitForOpen</code>. Browsers and Node.</p>
          </div>
        </div>

        <h3>Errors</h3>
        <p>Every failure is <a href="https://www.rfc-editor.org/rfc/rfc9457" target="_blank"
        rel="noopener">RFC 9457</a> problem+json with a stable <code>code</code> to branch on and a
        <code>field</code> when one input is at fault. <code>detail</code> is for humans and its
        wording is not part of the contract.</p>
        <pre class="dev-code"><code>{
  "type":   "https://peal.network/#/developers#invalid_tag",
  "title":  "invalid request",
  "status": 400,
  "code":   "invalid_tag",
  "detail": "a tag is up to 32 characters of a-z, 0-9, colon, hyphen or underscore",
  "field":  "tag"
}</code></pre>
        <p>Codes you can expect: <code>missing_deadline</code>, <code>opens_in_past</code>,
        <code>invalid_time</code>, <code>invalid_tag</code>, <code>invalid_cursor</code>,
        <code>invalid_status</code>, <code>invalid_base64</code>, <code>invalid_ciphertext</code>,
        <code>payload_too_large</code>, <code>round_closed</code>, <code>not_found</code>.</p>

        <h3>Rate limits</h3>
        <p>Every response carries <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> and
        <code>RateLimit-Reset</code>, so you can see your budget without having to be refused to
        learn it.</p>

        <h3>v0</h3>
        <p>The older surface (<code>/v0/conditions</code>, <code>/v0/ciphertexts</code>,
        <code>/v0/reveals</code>) is unchanged and still serves every existing client. New
        integrations should use v1.</p>
        </div>
      </section>

      <section id="next" class="scroll-reveal">
        <h2>Peal Commit</h2>
        <p>The rounds API above is the general shape: many seals, one deadline. Most callers, and
        nearly every agent, want the narrow one: seal a thing until a time, get something back that
        proves it was sealed before it was opened. That is one call.</p>

        <pre class="dev-code"><code>POST ${shown}/v1/seals

{
  "ciphertext_b64": "…",             // encrypted on your side, always
  "unlock_at":      "2026-09-12T18:00:00Z",
  "tag":            "my-app"
}

→ {
  "id":         "4f858dc3…",         // sha256 of the ciphertext
  "round_id":   "cond_…",
  "unlock_at":  "2026-09-12T18:00:00Z",
  "proof_url":  "/v1/seals/4f858dc3…/proof"
}</code></pre>

        <p>Or with the client, which does the encryption:</p>
        <pre class="dev-code"><code>import { peal } from '${shown}/peal.js';

const { id, proof_url } = await peal.sealUntil('the agent\'s bid', '2026-09-12T18:00:00Z');
const proof = await peal.getProof(id);</code></pre>

        <p class="dev-note"><strong>There is no field that takes a plaintext.</strong> Encrypting
        on our side would move the encryption to the wrong end of the network and delete the only
        property this has. The payload is a ciphertext or it is not accepted.</p>

        <h3>What the proof actually proves</h3>
        <p><code>GET /v1/seals/{id}/proof</code> returns the checkable facts and nothing else. The
        load-bearing one is <code>ordering_committed_at</code>: the coordinator writes the batch's
        ordering root at freeze, before any operator is handed work, so a commitment timestamp
        earlier than the reveal is evidence that the set and its order were fixed before anybody
        could open it. Before the round opens, the reveal fields are <code>null</code> rather than
        <code>false</code>, because "not yet" and "no" are different answers.</p>
        <pre class="dev-code"><code>{
  "seal_id":                    "4f858dc3…",   // recompute it from your own copy
  "position":                   3,             // from the ciphertext hashes, not arrival order
  "ordering_root":              "0x…",
  "ordering_committed_at":      1788490917,
  "merkle_root":                "0x…",
  "revealed_at":                1788494517,
  "commitment_precedes_reveal": true,
  "threshold":                  "3 of 5 operators are required to open a batch"
}</code></pre>

        <h3>What is built, and what is not</h3>
        <p>Every endpoint on this page is live and every example runs against the network. These
        are the pieces that are not, so you can see the edge of the thing before you plan around
        it.</p>
        <ul class="dev-status">
          <li><span class="dev-st dev-st-live">live</span><code>POST /v1/seals</code>
            <em>seal until a time, in one call</em></li>
          <li><span class="dev-st dev-st-live">live</span><code>GET /v1/seals/{id}/proof</code>
            <em>ordering commitment, merkle root, threshold</em></li>
          <li><span class="dev-st dev-st-next">shipping next</span><code>webhook</code> on a seal
            <em>we would call you at the deadline; today you poll the round, which an ETag makes
            nearly free</em></li>
          <li><span class="dev-st dev-st-next">shipping next</span><code>POST /v1/rounds</code> with
            an invite list <em>multi-party rounds where the participants are known up front</em></li>
          <li><span class="dev-st dev-st-planned">planned</span>MCP tool
            <code>seal_until(payload, unlockAt)</code> <em>so an agent can reach this without an
            SDK</em></li>
          <li><span class="dev-st dev-st-planned">planned</span>paid access over
            <a href="https://docs.x402.org/introduction" target="_blank" rel="noopener">x402</a>
            <em>pay per call in a request, no account; the devnet is free and unmetered</em></li>
          <li><span class="dev-st dev-st-planned">planned</span>typed SDKs for TypeScript, Python
            and Go <em>peal.js and plain HTTP cover it today</em></li>
        </ul>
        <p class="dev-note">An agent cannot sign up for anything: it cannot accept terms, hold an
        API key it did not earn, or expense a subscription. It can pay for one request. That is why
        per-call payment is on this list rather than a plan and a dashboard.</p>
      </section>

      <section id="identify" class="scroll-reveal">
        <h2>Name your app</h2>
        <p>Pass a <code>tag</code> when you create a condition. It is how you query your own
        conditions later, and it puts your app on the board below.</p>
        <pre class="dev-code"><code>body: JSON.stringify({ in_secs: 60, tag: 'my-app' })</code></pre>
        <p class="dev-note">Tags are up to 32 characters of <code>a-z 0-9 : _ -</code>. They are
        labels rather than registered names, so treat the board as a directory of what is being
        built on the network.</p>
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
        <h3>Security model</h3>
        <p>Payloads are encrypted in your process against the committee's public parameters, whose
        digest the client verifies before using them, so a coordinator serving inconsistent
        parameters fails loudly. The coordinator stores ciphertexts and never holds a key that
        opens one on its own. Opening a batch takes three of the five operators; two cannot.</p>
        <p>Every reveal is checkable after the fact: payloads come back with their positions and a
        merkle root over the set, and positions are derived from the ciphertext hashes rather than
        arrival order, so a batch cannot be reordered or quietly edited. The
        <a href="#/protocol">protocol reference</a> documents the committee, the ceremony and the
        full threat model, and the <button type="button" class="dev-jump"
        data-section="board">conditions explorer</button> shows every reveal the network has
        performed.</p>
        <p>This is the v0 devnet. Parameters, addresses and endpoints are stable, and the committee
        composition is documented in the protocol reference.</p>
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
    // A bar against the busiest tag. Fourteen numbers in a column are a table
    // nobody reads; the same numbers with a length are a shape you take in at a
    // glance, and the figures stay beside them for anyone who wants them.
    const top = Math.max(1, ...s.tags.map((t) => t.conditions));
    const rows = s.tags.map((t, i) => {
      const share = Math.max(2, Math.round((t.conditions / top) * 100));
      const live = t.recent > 0;
      return `
      <li class="dev-rank${live ? ' is-live' : ''}">
        <span class="dev-rank-n mono">${i + 1}</span>
        <span class="dev-rank-tag mono">${esc(t.tag)}${
          live ? `<span class="dev-live" title="${nf.format(t.recent)} in the last 24 hours">active</span>` : ''}</span>
        <span class="dev-rank-bar" aria-hidden="true"><i style="width:${share}%"></i></span>
        <span class="dev-rank-num" title="rounds created">${nf.format(t.conditions)}</span>
        <span class="dev-rank-num" title="payloads sealed by callers">${nf.format(t.ciphertexts)}</span>
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
        </li>
        ${rows}
      </ol>
      <p class="field-hint">${nf.format(s.recent.conditions)} condition${s.recent.conditions === 1 ? '' : 's'}
      and ${nf.format(s.recent.sealed)} payload${s.recent.sealed === 1 ? '' : 's'} in the last 24 hours.</p>`;
  };

  /** Say so, rather than leaving the ellipsis there for ever.
   *
   * The first version swallowed every failure and left "…" on screen, which
   * reads as a page still loading when it is in fact a page that has given up.
   * A dash is honest and takes the same room. */
  const paintUnavailable = (): void => {
    const facts = root.querySelector('#dev-facts');
    if (facts && facts.textContent?.includes('…')) {
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
      // A dev server with no coordinator behind it answers /v0 with the app
      // shell, so a 200 is not on its own proof of an answer.
      const isJson = res.headers.get('content-type')?.includes('application/json');
      if (!res.ok || !isJson) throw new Error(`stats unavailable (${res.status})`);
      const body = (await res.json()) as Stats;
      if (typeof body?.totals?.conditions !== 'number') throw new Error('unexpected shape');
      paintStats(body);
    } catch {
      paintUnavailable();
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

  // ---- section nav ----
  // Buttons rather than anchors throughout: an href="#next" would rewrite
  // location.hash and take the router off this page entirely.
  const nav = root.querySelector<HTMLElement>('.protocol-nav');
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.protocol-nav [data-section]'));
  const setCurrent = (id: string): void => {
    for (const b of buttons) {
      if (b.dataset.section === id) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    }
  };
  const jump = (event: Event): void => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-section]');
    if (!button) return;
    const id = button.dataset.section ?? '';
    setCurrent(id);
    document.getElementById(id)?.scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  };
  nav?.addEventListener('click', jump);
  // The same handler for links inside the prose that point at a section.
  const inline = Array.from(root.querySelectorAll<HTMLButtonElement>('.dev-jump'));
  for (const b of inline) b.addEventListener('click', jump);

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top));
      const id = visible[0]?.target.id;
      if (id) setCurrent(id);
    },
    { rootMargin: '-10% 0px -76% 0px' },
  );
  for (const [id] of sections) {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  }

  const stopReveal = mountScrollReveal(root);
  return () => {
    stopped = true;
    if (timer) window.clearTimeout(timer);
    nav?.removeEventListener('click', jump);
    for (const b of inline) b.removeEventListener('click', jump);
    observer.disconnect();
    stopReveal();
    document.title = previousTitle;
  };
}
