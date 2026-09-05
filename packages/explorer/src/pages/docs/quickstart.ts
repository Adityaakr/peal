/** The three calls, runnable against the live network. */
import type { DocsPage } from '../../docs';
import { type Demo, base, client, demoHtml, readJson, shown, wireDemos } from './runner';

/**
 * Undo the padding envelope before showing a payload.
 *
 * peal.js pads what it seals, because a sealed length is public the moment a
 * ciphertext is submitted and an unpadded bid announces its own size. The
 * padded form is `01`, a four byte big endian length, the payload, then zeros
 * to the next bucket. `payload_b64` is the bytes that were revealed, envelope
 * and all, so decoding it raw prints five bytes of header and a tail of NULs,
 * which is exactly what this page used to do.
 *
 * Anything that is not this envelope comes back as it came: a round can hold
 * payloads from clients that never used one, and one caller's format choice
 * must not make somebody else's payload unreadable.
 */
function unwrapPayload(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const decode = (v: Uint8Array): string => new TextDecoder().decode(v);
  if (bytes.length < 5 || bytes[0] !== 1) return decode(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(1, false);
  if (5 + length > bytes.length) return decode(bytes);
  for (let i = 5 + length; i < bytes.length; i++) if (bytes[i] !== 0) return decode(bytes);
  return decode(bytes.slice(5, 5 + length));
}

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
  headers: {
    'content-type': 'application/json',
    // Retry-safe: the same key returns the same round, never a second one.
    'idempotency-key': crypto.randomUUID(),
  },
  body: JSON.stringify({
    opens_in: 3600,                // or opens_at: '2026-09-12T18:00:00Z'
    tag: 'my-app',                 // how you list your own rounds later
    title: 'Signed tour poster',   // public now; the sealed payloads come next
  }),
});

const round = await res.json();
if (!res.ok) throw new Error(\`\${round.code}: \${round.detail}\`);`,
    run: async (log, state) => {
      const res = await fetch(`${base}/v1/rounds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ opens_in: 60, tag: 'docs:try', title: 'Signed tour poster' }),
      });
      const body = (await readJson(res, 'POST /v1/rounds')) as { id?: string };
      log(JSON.stringify(body, null, 2));
      if (body.id) {
        state.roundId = body.id;
        log(`\nkept as the round for step 2.`);
      }
    },
  },
  {
    id: 'seal',
    title: '2. Seal a payload to it',
    note: `The only step that needs code, because this is where the encryption happens and it
           happens on your machine. <code>peal.js</code> loads straight from this domain: one
           file, nothing to install. Payloads are padded to a fixed width first, so the
           ciphertext length says nothing about what is inside it.`,
    code: `import { peal } from '${shown}/peal.js';

// Encrypts in this process. Only the ciphertext crosses the network.
const seal = await peal.seal('my sealed bid', round.id);

// seal.id is the sha256 of that ciphertext: recompute it from your own
// copy rather than taking our word for which seal is yours.`,
    run: async (log, state) => {
      if (!state.roundId) {
        log('run step 1 first: this needs a round to seal to.');
        return;
      }
      const secret = `sealed from the docs at ${new Date().toISOString()}`;
      log(`sealing: ${secret}\n`);
      const sealed = await client.seal(secret, state.roundId);
      log(JSON.stringify(sealed, null, 2));
      log(`\nunreadable from here until the round opens.`);
    },
  },
  {
    id: 'read',
    title: '3. Read the round',
    note: `One URL, every stage, always 200. While the round is open you get a status and a
           count; once it opens the same call reports <code>opened</code> and the payloads are
           available. Send <code>If-None-Match</code> with the ETag and unchanged polls cost a
           304 instead of a response body.`,
    code: `const res = await fetch(\`${shown}/v1/rounds/\${round.id}\`, {
  headers: etag ? { 'if-none-match': etag } : {},
});
if (res.status === 304) return;           // nothing has moved
etag = res.headers.get('etag');

const state = await res.json();
if (state.status !== 'opened') return;    // 'open' | 'closing' | 'opened'

const { data } = await fetch(\`${shown}/v1/rounds/\${round.id}/seals\`)
  .then((r) => r.json());`,
    run: async (log, state) => {
      const id = state.roundId;
      if (!id) {
        log('run step 1 first.');
        return;
      }
      const res = await fetch(`${base}/v1/rounds/${encodeURIComponent(id)}`);
      const round = (await readJson(res, 'GET /v1/rounds/{id}')) as {
        status?: string; seals?: number; opens_at_unix?: number;
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
        const text = s.payload_b64 ? unwrapPayload(s.payload_b64) : '(sealed)';
        log(`  ${s.id.slice(0, 12)}…  ${text}`);
      }
    },
  },
];

export const quickstart: DocsPage = {
  title: 'Quickstart',
  lede: 'Three calls against the live network, from this page. No signup, no API key, no wallet.',
  html: `
    <h2 id="the-three-calls">The three calls</h2>
    <p>Run them in order. Step one and three are ordinary HTTP that curl can do; step two needs
    the library, because that is where your data actually gets encrypted.</p>
    ${demos.map(demoHtml).join('')}

    <h2 id="what-just-happened">What just happened</h2>
    <p>A round is a row in the coordinator naming a moment. It fires on its own whether or not
    anyone is watching, which is what separates this from a commit and reveal scheme: the reveal
    is not a move a participant has to make, so nobody can decline it after seeing they have
    lost.</p>
    <p>The payload was encrypted in your browser against the committee's public parameters, whose
    digest the client checked before using them. What crossed the network was already a
    ciphertext.</p>
    <p>The 404 before the cue is the guarantee working, not an error to handle: there is
    genuinely nothing readable to return.</p>`,
  mount: (root) => wireDemos(root, demos, { bidders: 0 }),
};
