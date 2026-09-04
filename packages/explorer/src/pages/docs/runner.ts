/** Runnable examples, shared by the pages that have them.
 *
 * A code sample nobody has executed is a claim. One with a run button beside it
 * and the real response printed underneath is a demonstration, and the
 * difference matters most for a network whose whole proposition is that things
 * open on time.
 */
import { Peal } from '../../../embed/peal';
import { API_BASE } from '../../api';
import { esc } from '../../util';

/** Two different things, and conflating them ships broken documentation.
 *
 * API_BASE is empty in production because these pages are served from the same
 * origin as the coordinator, which is right for OUR fetches and wrong for every
 * sample: somebody pasting `fetch('/v1/rounds')` into their own app would be
 * calling their own server. Samples get an absolute URL; our calls stay
 * relative. */
export const base = API_BASE.replace(/\/$/, '');
export const shown = base || (typeof window === 'undefined' ? 'https://peal.network' : window.location.origin);
export const client = new Peal({ url: base });

export interface DemoState {
  roundId?: string;
  auctionId?: string;
  bidders: number;
}

export interface Demo {
  id: string;
  title: string;
  note: string;
  code: string;
  run: (log: (line: string) => void, state: DemoState) => Promise<void>;
}

export function demoHtml(d: Demo): string {
  return `
    <div class="dev-demo" data-demo="${esc(d.id)}">
      <div class="dev-demo-head">
        <h3 id="${esc(d.id)}">${esc(d.title)}</h3>
        <button class="btn dev-run" type="button" data-run="${esc(d.id)}">run it</button>
      </div>
      <p class="dev-note">${d.note}</p>
      <pre class="dev-code"><code>${esc(d.code)}</code></pre>
      <pre class="dev-out" data-out="${esc(d.id)}" hidden></pre>
    </div>`;
}

/**
 * Read a response, or say what actually went wrong.
 *
 * `res.json()` on an empty body throws "unexpected end of JSON input", which
 * tells a reader nothing: a 404 from a proxy that does not forward the route
 * and a 405 from a static file server both look exactly like that, and neither
 * is a problem with the JSON.
 */
export async function readJson(res: Response, what: string): Promise<unknown> {
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

/** Wire every run button on the page. Returns a cleanup. */
export function wireDemos(root: HTMLElement, demos: Demo[], state: DemoState): () => void {
  const listeners: [HTMLButtonElement, () => void][] = [];
  for (const btn of Array.from(root.querySelectorAll<HTMLButtonElement>('.dev-run'))) {
    const demo = demos.find((d) => d.id === btn.dataset.run);
    const out = root.querySelector<HTMLElement>(`[data-out="${btn.dataset.run}"]`);
    if (!demo || !out) continue;

    const onClick = async (): Promise<void> => {
      out.hidden = false;
      out.textContent = '';
      btn.disabled = true;
      btn.textContent = 'running…';
      const log = (line: string): void => {
        out.textContent = `${out.textContent}${line}\n`;
      };
      try {
        await demo.run(log, state);
      } catch (e) {
        log(`failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        btn.disabled = false;
        btn.textContent = 'run it';
      }
    };
    btn.addEventListener('click', () => void onClick());
    listeners.push([btn, onClick]);
  }
  return () => {
    for (const [btn, fn] of listeners) btn.removeEventListener('click', fn);
  };
}
