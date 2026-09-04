/** The API reference, with a playground on every endpoint.
 *
 * Rendered from api-spec.ts, so the prose, the curl snippet and the thing the
 * run button actually sends are one description. A reference written by hand
 * beside a playground written separately drifts, and the playground is the half
 * nobody notices is stale, because it only breaks when somebody presses run.
 *
 * The playground sends real requests to the live network. That is the point:
 * a caller sees the response their own code will get, including the errors.
 */
import type { DocsPage } from '../../docs';
import { esc } from '../../util';
import { ENDPOINTS, GROUPS, type Endpoint, type Param } from './api-spec';
import { base, client, shown } from './runner';

/** Ids created by running one endpoint, offered to the next.
 *
 * Reading a round needs a round. Without this a caller has to run the first
 * endpoint, copy an id out of the response and paste it into the second, which
 * is enough friction that most people never press the second button. */
const remembered: Partial<Record<'round' | 'seal', string>> = {};

function methodClass(m: string): string {
  return m === 'POST' ? 'api-m-post' : 'api-m-get';
}

/** The curl a caller would run, built from the same spec the playground uses. */
function curlFor(e: Endpoint, values: Record<string, string>): string {
  let path = e.path;
  for (const p of e.params.filter((x) => x.in === 'path')) {
    path = path.replace(`{${p.name}}`, values[p.name] || `{${p.name}}`);
  }
  const query = e.params
    .filter((p) => p.in === 'query' && values[p.name])
    .map((p) => `${p.name}=${encodeURIComponent(values[p.name]!)}`)
    .join('&');

  const lines = [`curl${e.method === 'POST' ? ' -X POST' : ''} \\`];
  lines.push(`  '${shown}${path}${query ? `?${query}` : ''}'`);

  const headers = e.params.filter((p) => p.in === 'header' && values[p.name]);
  const body = e.params.filter((p) => p.in === 'body' && values[p.name]);
  if (body.length) lines[lines.length - 1] += ` \\`;
  if (body.length) lines.push(`  -H 'content-type: application/json' \\`);
  for (const h of headers) lines.push(`  -H '${h.name}: ${values[h.name]}' \\`);
  if (body.length) {
    const json = body
      .map((p) => `    "${p.name}": ${p.numeric ? values[p.name] : JSON.stringify(values[p.name])}`)
      .join(',\n');
    lines.push(`  -d '{\n${json}\n  }'`);
  } else if (lines[lines.length - 1]!.endsWith('\\')) {
    lines[lines.length - 1] = lines[lines.length - 1]!.replace(/ \\$/, '');
  }
  return lines.join('\n');
}

function paramRow(p: Param): string {
  return `
    <div class="api-param">
      <p class="api-param-head">
        <code>${esc(p.name)}</code>
        <span class="api-type">${esc(p.type)}</span>
        ${p.required ? '<span class="api-req">required</span>' : ''}
      </p>
      <p class="api-param-desc">${esc(p.description)}</p>
    </div>`;
}

function fieldFor(e: Endpoint, p: Param): string {
  const id = `${e.id}--${p.name}`;
  return `
    <label class="api-field">
      <span><code>${esc(p.name)}</code>${p.required ? '<em>required</em>' : ''}</span>
      <input id="${esc(id)}" data-endpoint="${esc(e.id)}" data-param="${esc(p.name)}"
             placeholder="${esc(p.example ?? p.type)}" value="${esc(p.example ?? '')}"
             autocomplete="off" spellcheck="false" />
    </label>`;
}

function endpointHtml(e: Endpoint): string {
  const groups: [string, Param[]][] = [
    ['Path parameters', e.params.filter((p) => p.in === 'path')],
    ['Query parameters', e.params.filter((p) => p.in === 'query')],
    ['Body', e.params.filter((p) => p.in === 'body')],
    ['Headers', e.params.filter((p) => p.in === 'header')],
  ];
  const editable = e.params.filter((p) => p.in !== 'header' || p.name === 'Idempotency-Key');

  return `
  <section class="api-endpoint" id="${esc(e.id)}" data-endpoint="${esc(e.id)}">
    <div class="api-head">
      <h3>${esc(e.title)}</h3>
      <p class="api-sig">
        <span class="api-method ${methodClass(e.method)}">${e.method}</span>
        <code>${esc(e.path)}</code>
      </p>
      <p class="api-summary">${esc(e.summary)}</p>
    </div>

    <div class="api-cols">
      <div class="api-doc">
        ${groups
          .filter(([, ps]) => ps.length)
          .map(([label, ps]) => `<h4>${label}</h4>${ps.map(paramRow).join('')}`)
          .join('')}
        ${e.note ? `<p class="api-note">${esc(e.note)}</p>` : ''}
      </div>

      <div class="api-panel">
        <div class="api-try">
          <p class="api-try-head">Try it</p>
          ${editable.length ? editable.map((p) => fieldFor(e, p)).join('') : '<p class="api-noparams">No parameters. Press run.</p>'}
          ${e.needsSeal ? `
          <p class="api-seal-hint">A ciphertext cannot be typed. This encrypts a
          sample payload in your browser and fills the field.</p>
          <button class="api-btn api-seal" type="button" data-seal="${esc(e.id)}">encrypt a sample</button>` : ''}
          <button class="api-btn api-run" type="button" data-run="${esc(e.id)}">run</button>
          <pre class="api-out" data-out="${esc(e.id)}" hidden></pre>
        </div>

        <div class="api-sample">
          <p class="api-sample-head">Request</p>
          <pre class="doc-code api-curl" data-curl="${esc(e.id)}"><code>${esc(curlFor(e, Object.fromEntries(e.params.filter((p) => p.example).map((p) => [p.name, p.example!]))))}</code></pre>
          <p class="api-sample-head">Response</p>
          <pre class="doc-code"><code>${esc(e.response)}</code></pre>
        </div>
      </div>
    </section>`;
}

export const apiReference: DocsPage = {
  title: 'API reference',
  lede: 'Every endpoint, with a playground on each one. The requests go to the live network, so what you see is what your own code will get.',
  wide: true,
  html: `
    <p>Base URL <code>${esc(shown)}</code>. Everything is JSON. Nothing here needs a key, an
    account or a payment, and every endpoint below can be run from this page.</p>
    <p>Ids carry forward: run <strong>Open a round</strong> and the round id fills itself into the
    endpoints that need one, so you can work down the page without copying anything.</p>

    ${GROUPS.map(
      (g) => `
      <div class="api-group" id="${g.toLowerCase()}">
        <h2>${g}</h2>
        <span>${ENDPOINTS.filter((e) => e.group === g).length} endpoints</span>
        <span class="api-group-rule"></span>
      </div>
      ${ENDPOINTS.filter((e) => e.group === g).map(endpointHtml).join('')}`,
    ).join('')}

    <h2 id="errors">Errors</h2>
    <p>Every failure is <a href="https://www.rfc-editor.org/rfc/rfc9457" target="_blank"
    rel="noopener">RFC 9457</a> problem+json with a stable <code>code</code> to branch on and a
    <code>field</code> when one input is at fault. <code>detail</code> is for people and its
    wording is not part of the contract.</p>
    <pre class="doc-code"><code>{
  "type":   "https://peal.network/#/developers#invalid_maximum",
  "title":  "invalid request",
  "status": 400,
  "code":   "invalid_maximum",
  "detail": "the maximum cannot be below the reserve",
  "field":  "maximum_minor"
}</code></pre>
    <p>The full list is on <a href="#/developers/limits">limits and errors</a>.</p>

    <h2 id="rate-limits">Rate limits</h2>
    <p>50 requests a second per IP, bursting to 400. Every response carries
    <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> and
    <code>RateLimit-Reset</code>, so you never have to be refused to learn your budget.</p>`,

  mount: (root) => {
    const cleanups: (() => void)[] = [];

    const valuesFor = (e: Endpoint): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const p of e.params) {
        const el = root.querySelector<HTMLInputElement>(`#${CSS.escape(`${e.id}--${p.name}`)}`);
        const v = el?.value.trim();
        if (v) out[p.name] = v;
      }
      return out;
    };

    const refreshCurl = (e: Endpoint): void => {
      const host = root.querySelector<HTMLElement>(`[data-curl="${e.id}"] code`);
      if (host) host.textContent = curlFor(e, valuesFor(e));
    };

    // Ids flow forward, so the page can be worked down without copying. A round
    // id only fills fields that want a round: offering it to `GET /v1/seals/{id}`
    // produced a 404 on a button somebody had just pressed.
    const offerId = (kind: 'round' | 'seal', value: string): void => {
      remembered[kind] = value;
      for (const e of ENDPOINTS) {
        const param = e.params.find((p) => p.carry === kind);
        if (!param) continue;
        const el = root.querySelector<HTMLInputElement>(`#${CSS.escape(`${e.id}--${param.name}`)}`);
        if (el && !el.value) {
          el.value = value;
          refreshCurl(e);
        }
      }
    };

    for (const input of Array.from(root.querySelectorAll<HTMLInputElement>('.api-field input'))) {
      const e = ENDPOINTS.find((x) => x.id === input.dataset.endpoint);
      if (!e) continue;
      const carry = e.params.find((p) => p.name === input.dataset.param)?.carry;
      if (carry && remembered[carry] && !input.value) input.value = remembered[carry]!;
      const onInput = (): void => refreshCurl(e);
      input.addEventListener('input', onInput);
      cleanups.push(() => input.removeEventListener('input', onInput));
      refreshCurl(e);
    }

    // A ciphertext cannot be typed, so the page makes one.
    for (const btn of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-seal]'))) {
      const e = ENDPOINTS.find((x) => x.id === btn.dataset.seal);
      const field = root.querySelector<HTMLInputElement>(`#${CSS.escape(`${btn.dataset.seal}--ciphertext_b64`)}`);
      if (!e || !field) continue;
      const onSeal = async (): Promise<void> => {
        btn.disabled = true;
        btn.textContent = 'encrypting…';
        try {
          // A bid must be the fixed width bid record, not an arbitrary payload:
          // anything else decodes to nothing and is discarded at the reveal.
          const auctionId = valuesFor(e).id;
          const sealed = e.id === 'place-bid'
            ? await client.encryptBid(auctionId ?? '', { amountMinor: 125_00, name: 'ana' })
            : await client.encrypt(`sealed from the api reference at ${new Date().toISOString()}`);
          field.value = sealed;
          refreshCurl(e);
          btn.textContent = 'encrypted, now press run';
        } catch (err) {
          btn.textContent = err instanceof Error ? err.message : 'could not encrypt';
        } finally {
          btn.disabled = false;
          window.setTimeout(() => { btn.textContent = 'encrypt a sample'; }, 2600);
        }
      };
      btn.addEventListener('click', () => void onSeal());
      cleanups.push(() => btn.removeEventListener('click', () => void onSeal()));
    }

    for (const btn of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-run]'))) {
      const e = ENDPOINTS.find((x) => x.id === btn.dataset.run);
      const out = root.querySelector<HTMLElement>(`[data-out="${btn.dataset.run}"]`);
      if (!e || !out) continue;

      const onRun = async (): Promise<void> => {
        const values = valuesFor(e);
        out.hidden = false;
        out.textContent = 'running…';
        btn.disabled = true;

        try {
          let path = e.path;
          for (const p of e.params.filter((x) => x.in === 'path')) {
            if (!values[p.name]) throw new Error(`${p.name} is required. Run an endpoint above to fill it in.`);
            path = path.replace(`{${p.name}}`, encodeURIComponent(values[p.name]!));
          }
          const query = e.params
            .filter((p) => p.in === 'query' && values[p.name])
            .map((p) => `${p.name}=${encodeURIComponent(values[p.name]!)}`)
            .join('&');

          const headers: Record<string, string> = {};
          for (const p of e.params.filter((x) => x.in === 'header')) {
            if (values[p.name]) headers[p.name] = values[p.name]!;
          }

          const bodyParams = e.params.filter((p) => p.in === 'body' && values[p.name]);
          let body: string | undefined;
          if (bodyParams.length) {
            headers['content-type'] = 'application/json';
            body = JSON.stringify(
              Object.fromEntries(
                bodyParams.map((p) => [p.name, p.numeric ? Number(values[p.name]) : values[p.name]]),
              ),
            );
          }

          const started = performance.now();
          const res = await fetch(`${base}${path}${query ? `?${query}` : ''}`, {
            method: e.method,
            headers,
            body,
          });
          const ms = Math.round(performance.now() - started);
          const text = await res.text();

          const budget = res.headers.get('ratelimit-remaining');
          const etag = res.headers.get('etag');
          const meta = [`${res.status} ${res.statusText}`.trim(), `${ms}ms`]
            .concat(budget ? [`${budget} requests left`] : [])
            .concat(etag ? [`etag ${etag}`] : [])
            .join('  ·  ');

          let pretty = text;
          try {
            const parsed: unknown = JSON.parse(text);
            pretty = JSON.stringify(parsed, null, 2);
            // A response can carry both: POST /v1/seals returns the seal's
            // own hash and the round it made.
            const { id, round_id: roundId } = parsed as { id?: string; round_id?: string };
            if (roundId?.startsWith('cond_')) offerId('round', roundId);
            if (id?.startsWith('cond_')) offerId('round', id);
            else if (id && /^[0-9a-f]{64}$/.test(id)) offerId('seal', id);
          } catch {
            if (!text.trim()) pretty = '(no body)';
          }

          out.textContent = `${meta}\n\n${pretty}`;
          out.classList.toggle('is-error', !res.ok);
        } catch (err) {
          out.textContent = err instanceof Error ? err.message : String(err);
          out.classList.add('is-error');
        } finally {
          btn.disabled = false;
        }
      };
      btn.addEventListener('click', () => void onRun());
      cleanups.push(() => btn.removeEventListener('click', () => void onRun()));
    }

    return () => {
      for (const done of cleanups) done();
    };
  },
};
