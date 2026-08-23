// The playground: seal into the network from this tab and watch the reveal
// land on cue. Three scenarios show what reveal-later encryption is for:
//   sealed bid   -> joins a shared round; highest bid wins at reveal
//   hidden vote  -> joins a shared round; the tally appears all at once
//   time capsule -> your own note, revealed to everyone later
// Sealing runs in bte-sdk's wasm; only the ciphertext leaves the tab. A live
// trace narrates every stage with the real artifacts.
import { BteClient, MAX_PAYLOAD_BYTES } from 'bte-sdk';
import {
  API_BASE,
  getCondition,
  getReveal,
  listConditions,
  type ConditionDetail,
  type Reveal,
} from './api';
import { markSealRevealed, rememberSeal } from './attention';
import { createCeremony, type Ceremony } from './ceremony';
import { takeSealDraft } from './draft';
import { decryptPrivateBytes, encryptPrivateBytes, isPrivatePayload } from './privacy';
import type { SealedFile } from './attach';
import { ACCEPTED, fmtBytes, isFilePayload, packFile, renderFile, unpackFile } from './attach';
import { decodePayload, esc, fmtCountdown, payloadBytes, truncMiddle } from './util';

const POLL_MS = 1500;
const ROUND_SECS = 60;
/** Do not join a round about to freeze; sealing would race the cue. */
const MIN_JOIN_SECS = 12;

type Scenario = 'bid' | 'vote' | 'note';

const SCENARIO_LABEL: Record<Scenario, string> = {
  bid: 'your sealed bid',
  vote: 'your hidden vote',
  note: 'your time capsule',
};

/** ctHashes already written to the watched-seals list this session. */
const watched = new Set<string>();

interface PlaygroundRun {
  conditionId: string;
  ctHash: string;
  /** Short server-issued share code, minted with the ciphertext. */
  code?: string;
  scenario: Scenario;
  /** What this tab sealed, for the "you" marker and the capsule view. */
  summary: string;
  /** Private capsules: the AES key that travels only inside the share link. */
  shareKey?: string;
  n: number;
  t: number;
  b: number;
}

type StepState = 'todo' | 'active' | 'done';

interface TraceStep {
  label: string;
  detail: string;
  state: StepState;
}

interface Entry {
  ctHash: string;
  kind: 'bid' | 'vote' | 'text';
  name: string;
  amt?: number;
  choice?: string;
  text?: string;
}

function b64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Local-timezone value for a datetime-local input. */
function toLocal(d: Date): string {
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Recipient-side link: countdown first, content after the cue. Private
 * capsules carry the decryption key in the fragment, which never leaves
 * the browser. */
function sealLink(run: {
  conditionId: string;
  ctHash: string;
  shareKey?: string;
  code?: string;
}): string {
  // Short form when the coordinator minted a code (59 chars with a key, 36
  // without). The long form stays valid forever and is the fallback for
  // coordinators predating share codes.
  const origin = `${location.origin}${location.pathname}`;
  const base = run.code
    ? `${origin}#/s/${run.code}`
    : `${origin}#/s/${run.conditionId}/${run.ctHash}`;
  return run.shareKey ? `${base}/${run.shareKey}` : base;
}

/** Parse a revealed slot into a playground entry (bids/votes are JSON). */
function parseEntry(ctHash: string, text: string): Entry {
  try {
    const p = JSON.parse(text);
    if (p && p.k === 'bid' && typeof p.amt === 'number') {
      return { ctHash, kind: 'bid', name: String(p.name || 'anon'), amt: p.amt };
    }
    if (p && p.k === 'vote' && typeof p.choice === 'string') {
      return { ctHash, kind: 'vote', name: String(p.name || 'anon'), choice: p.choice };
    }
  } catch {
    // plain text payload
  }
  return { ctHash, kind: 'text', name: 'anon', text };
}

export function renderPlayground(host: HTMLElement): () => void {
  const client = new BteClient({ url: API_BASE });
  let scenario: Scenario = 'note';
  let run: PlaygroundRun | null = null;
  /** A file chosen for the next seal, already read into memory. */
  let picked: SealedFile | null = null;
  let fileCleanups: Array<() => void> = [];
  let pollTimer: number | undefined;
  let tickTimer: number | undefined;
  let condition: ConditionDetail | null = null;
  let done = false;
  let steps: TraceStep[] = [];
  let lastRest = '';
  /** The 3D seal scene, mounted once per run and driven by live share state. */
  let ceremony: Ceremony | null = null;

  host.innerHTML = `
    <div class="playground card" id="pg">
      <form id="pg-form" autocomplete="off">
        <div class="scenario-picker-head">
          <p class="scenario-kicker">Try Peal Playground</p>
          <p class="scenario-prompt">Choose a use case, add something private, then watch it reveal on cue.</p>
        </div>
        <div class="chips" role="tablist" aria-label="choose a use case">
          <button type="button" class="chip-btn" id="scenario-bid" role="tab" data-scenario="bid"
                  aria-selected="false" aria-controls="pg-fields" tabindex="-1">
            <span class="scenario-number" aria-hidden="true">1</span><span>sealed bid</span>
          </button>
          <button type="button" class="chip-btn" id="scenario-vote" role="tab" data-scenario="vote"
                  aria-selected="false" aria-controls="pg-fields" tabindex="-1">
            <span class="scenario-number" aria-hidden="true">2</span><span>hidden vote</span>
          </button>
          <button type="button" class="chip-btn" id="scenario-note" role="tab" data-scenario="note"
                  aria-selected="true" aria-controls="pg-fields" tabindex="0">
            <span class="scenario-number" aria-hidden="true">3</span><span>time capsule</span>
          </button>
        </div>
        <div id="pg-fields" role="tabpanel" aria-labelledby="scenario-note"></div>
        <p class="field-hint" id="pg-hint"></p>
        <p class="field-hint" id="pg-round"></p>
        <p class="error" id="pg-error" hidden></p>
      </form>
      <div id="pg-live" hidden></div>
    </div>
  `;

  const form = host.querySelector<HTMLFormElement>('#pg-form')!;
  const fieldsEl = host.querySelector<HTMLElement>('#pg-fields')!;
  const hintEl = host.querySelector<HTMLElement>('#pg-hint')!;
  const roundEl = host.querySelector<HTMLElement>('#pg-round')!;
  const errorEl = host.querySelector<HTMLElement>('#pg-error')!;
  const liveEl = host.querySelector<HTMLElement>('#pg-live')!;

  /** Round-length choices for the shared scenarios. The first sealer's pick
   * sets the round; everyone after joins whatever is open. */
  const roundSelect = () => `
    <select id="pg-round-secs" aria-label="round length">
      <option value="30">30s round</option>
      <option value="60" selected>60s round</option>
      <option value="120">2m round</option>
      <option value="300">5m round</option>
      <option value="600">10m round</option>
      <option value="3600">1h round</option>
      <option value="7200">2h round</option>
      <option value="21600">6h round</option>
      <option value="43200">12h round</option>
      <option value="86400">24h round</option>
      <option value="custom">pick a date…</option>
    </select>`;

  const roundUntilRow = () => `
    <div class="pg-row pg-until-row" id="pg-round-until-row" hidden>
      <label class="field-label" for="pg-round-until" style="margin:8px 0 0">round ends</label>
      <input id="pg-round-until" type="datetime-local" aria-label="round ends" />
    </div>`;

  /** Shows the date row when "pick a date…" is chosen on a bid/vote form. */
  function wireRoundPicker(): void {
    const sel = fieldsEl.querySelector<HTMLSelectElement>('#pg-round-secs');
    const row = fieldsEl.querySelector<HTMLElement>('#pg-round-until-row');
    const input = fieldsEl.querySelector<HTMLInputElement>('#pg-round-until');
    if (!sel || !row || !input) return;
    input.min = toLocal(new Date(Date.now() + 2 * 60_000));
    input.value = toLocal(new Date(Date.now() + 60 * 60_000));
    sel.addEventListener('change', () => {
      row.hidden = sel.value !== 'custom';
    });
  }

  function renderFields(): void {
    roundEl.textContent = ''; // never show the previous scenario's round note
    if (scenario === 'bid') {
      fieldsEl.innerHTML = `
        <div class="pg-row">
          <label class="pg-control pg-control-name" for="pg-name">
            <span class="field-label">your name</span>
            <input id="pg-name" name="name" type="text" maxlength="24" placeholder="Ada" autocomplete="name" />
          </label>
          <label class="pg-control pg-control-number" for="pg-amount">
            <span class="field-label">your bid</span>
            <input id="pg-amount" name="amount" type="text" inputmode="decimal" required
                   placeholder="100" aria-label="your bid" />
          </label>
          <label class="pg-control pg-control-select" for="pg-round-secs">
            <span class="field-label">round length</span>
            ${roundSelect()}
          </label>
          <button type="submit" class="btn btn-primary" id="pg-seal">seal my bid</button>
        </div>
        ${roundUntilRow()}`;
      hintEl.textContent =
        'nobody sees any bid until the round reveals. then every bid opens at once and the highest wins.';
      wireRoundPicker();
    } else if (scenario === 'vote') {
      fieldsEl.innerHTML = `
        <div class="pg-row">
          <label class="pg-control pg-control-name" for="pg-name">
            <span class="field-label">your name</span>
            <input id="pg-name" name="name" type="text" maxlength="24" placeholder="Ada" autocomplete="name" />
          </label>
          <label class="pg-control pg-control-select" for="pg-choice">
            <span class="field-label">your vote</span>
            <select id="pg-choice">
              <option value="yes">vote yes</option>
              <option value="no">vote no</option>
            </select>
          </label>
          <label class="pg-control pg-control-select" for="pg-round-secs">
            <span class="field-label">round length</span>
            ${roundSelect()}
          </label>
          <button type="submit" class="btn btn-primary" id="pg-seal">seal my vote</button>
        </div>
        ${roundUntilRow()}`;
      hintEl.textContent =
        'no running tallies, no bandwagons. every vote stays dark until the round reveals them together.';
      wireRoundPicker();
    } else {
      fieldsEl.innerHTML = `
        <div class="pg-row">
          <label class="pg-control pg-control-grow" for="pg-secret">
            <span class="field-label">what should stay sealed?</span>
            <input id="pg-secret" name="secret" type="text" maxlength="200" required
                   placeholder="a prediction, a confession, a launch date…" />
          </label>
          <label class="pg-control pg-control-select" for="pg-delay">
            <span class="field-label">reveal timing</span>
            <select id="pg-delay">
              <option value="30">reveal in 30s</option>
              <option value="60" selected>reveal in 60s</option>
              <option value="120">reveal in 2m</option>
              <option value="600">reveal in 10m</option>
              <option value="3600">reveal in 1h</option>
              <option value="7200">reveal in 2h</option>
              <option value="10800">reveal in 3h</option>
              <option value="21600">reveal in 6h</option>
              <option value="43200">reveal in 12h</option>
              <option value="86400">reveal in 24h</option>
              <option value="custom">pick a date…</option>
            </select>
          </label>
          <button type="submit" class="btn btn-primary" id="pg-seal">seal it</button>
        </div>
        <div class="pg-row pg-until-row" id="pg-until-row" hidden>
          <label class="field-label" for="pg-until" style="margin:8px 0 0">sealed until</label>
          <input id="pg-until" type="datetime-local" aria-label="sealed until" />
        </div>
        <div class="pg-attach">
          <label class="pg-attach-pick" for="pg-file">
            <input id="pg-file" type="file" accept="${ACCEPTED}" hidden />
            <span class="pg-attach-plus" aria-hidden="true">+</span>
            <span>attach a pdf or image</span>
          </label>
          <p class="pg-attach-chosen" id="pg-file-chosen" hidden></p>
        </div>
        <label class="pg-private-row">
          <input type="checkbox" id="pg-private" checked />
          private: only people with the share link can read it after the reveal
        </label>`;
      hintEl.textContent =
        'encrypted in this tab with wasm. nobody can read it early, us included.';
      // The picked file is held as bytes, so seal() never re-reads the input
      // (the element is replaced whenever the scenario tabs re-render).
      const fileInput = fieldsEl.querySelector<HTMLInputElement>('#pg-file')!;
      const chosenEl = fieldsEl.querySelector<HTMLElement>('#pg-file-chosen')!;
      const secretInput = fieldsEl.querySelector<HTMLInputElement>('#pg-secret')!;
      fileInput.addEventListener('change', () => {
        const f = fileInput.files?.[0];
        picked = null;
        if (!f) {
          chosenEl.hidden = true;
          secretInput.required = true;
          return;
        }
        if (f.size > MAX_PAYLOAD_BYTES) {
          chosenEl.hidden = false;
          chosenEl.className = 'pg-attach-chosen error';
          chosenEl.textContent = `${f.name} is ${fmtBytes(f.size)}. the cap is ${fmtBytes(
            MAX_PAYLOAD_BYTES,
          )} per seal.`;
          fileInput.value = '';
          return;
        }
        void f.arrayBuffer().then((buf) => {
          picked = { name: f.name, type: f.type || 'application/octet-stream', bytes: new Uint8Array(buf) };
          chosenEl.hidden = false;
          chosenEl.className = 'pg-attach-chosen';
          chosenEl.innerHTML = `<span class="pg-attach-name">${esc(f.name)}</span>
            <span class="muted">${esc(fmtBytes(f.size))}</span>
            <button type="button" class="pg-attach-x" id="pg-file-clear"
                    aria-label="remove attachment">remove</button>`;
          // With a file attached the caption is optional.
          secretInput.required = false;
          chosenEl.querySelector('#pg-file-clear')!.addEventListener('click', () => {
            picked = null;
            fileInput.value = '';
            chosenEl.hidden = true;
            secretInput.required = true;
          });
        });
      });

      const delaySel = fieldsEl.querySelector<HTMLSelectElement>('#pg-delay')!;
      const untilRow = fieldsEl.querySelector<HTMLElement>('#pg-until-row')!;
      const untilInput = fieldsEl.querySelector<HTMLInputElement>('#pg-until')!;
      const soon = new Date(Date.now() + 2 * 60_000);
      untilInput.min = toLocal(soon);
      untilInput.value = toLocal(new Date(Date.now() + 60 * 60_000));
      delaySel.addEventListener('change', () => {
        untilRow.hidden = delaySel.value !== 'custom';
      });
    }
    void updateRoundNote();
  }

  /** Newest pending round FOR THIS SCENARIO with enough time left to join
   * safely. Rounds are matched by tag, so bids never land in vote rounds and
   * nothing ever joins somebody's time capsule. Untagged (older) conditions
   * are never joined. */
  async function findOpenRound(tag: string): Promise<{ id: string; secs: number } | null> {
    try {
      const conditions = await listConditions();
      const now = Math.floor(Date.now() / 1000);
      const open = conditions.find(
        (c) =>
          c.status === 'pending' && c.kind === 'at_time' && c.fires_at != null &&
          c.tag === tag && c.fires_at - now >= MIN_JOIN_SECS,
      );
      return open ? { id: open.id, secs: open.fires_at! - now } : null;
    } catch {
      return null;
    }
  }

  const roundTag = () => `round:${scenario}`;

  function chosenRoundSecs(): number {
    const v = host.querySelector<HTMLSelectElement>('#pg-round-secs')?.value ?? String(ROUND_SECS);
    if (v === 'custom') {
      const untilVal = host.querySelector<HTMLInputElement>('#pg-round-until')?.value ?? '';
      const until = new Date(untilVal);
      if (!untilVal || Number.isNaN(until.getTime()) || until.getTime() < Date.now() + 60_000) {
        throw new Error('pick a date at least a minute in the future');
      }
      return Math.round((until.getTime() - Date.now()) / 1000);
    }
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : ROUND_SECS;
  }

  async function updateRoundNote(): Promise<void> {
    if (scenario === 'note') {
      roundEl.textContent = '';
      return;
    }
    const forScenario = scenario;
    const open = await findOpenRound(roundTag());
    if (scenario !== forScenario) return; // user switched while we fetched
    roundEl.textContent = open
      ? `joins the open ${forScenario} round, reveals in ${open.secs}s. open this page in another tab to compete.`
      : `starts a new ${forScenario} round with the length you pick. open this page in another tab to compete.`;
  }

  const scenarioButtons = Array.from(host.querySelectorAll<HTMLButtonElement>('.chip-btn'));

  function selectScenario(btn: HTMLButtonElement): void {
    scenario = btn.dataset.scenario as Scenario;
    scenarioButtons.forEach((b) => {
      const selected = b === btn;
      b.setAttribute('aria-selected', String(selected));
      b.tabIndex = selected ? 0 : -1;
    });
    fieldsEl.setAttribute('aria-labelledby', btn.id);
    errorEl.hidden = true;
    renderFields();
  }

  scenarioButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectScenario(btn);
    });
    btn.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = scenarioButtons.indexOf(btn);
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? scenarioButtons.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + scenarioButtons.length) % scenarioButtons.length;
      scenarioButtons[next].focus();
      selectScenario(scenarioButtons[next]);
    });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void seal();
  });

  renderFields();

  // A visitor who typed into the landing prompt already answered "what should
  // stay sealed?" — land them in the capsule composer with it filled in, ready
  // to seal, instead of asking the same question twice.
  const draft = takeSealDraft();
  if (draft) {
    const noteBtn = host.querySelector<HTMLButtonElement>('#scenario-note');
    if (scenario !== 'note' && noteBtn) selectScenario(noteBtn);
    const secretEl = fieldsEl.querySelector<HTMLInputElement>('#pg-secret');
    if (secretEl) {
      secretEl.value = draft.slice(0, secretEl.maxLength);
      secretEl.focus();
      secretEl.setSelectionRange(secretEl.value.length, secretEl.value.length);
      host.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  const roundTimer = window.setInterval(() => {
    if (!run) void updateRoundNote();
  }, 5000);

  function initSteps(): void {
    steps = [
      { label: 'fetch committee params', detail: '', state: 'todo' },
      { label: 'encrypt in wasm (FO transform)', detail: '', state: 'todo' },
      { label: 'content-address the ciphertext', detail: '', state: 'todo' },
      { label: 'post to the coordinator', detail: '', state: 'todo' },
      { label: 'cue fires, batch freezes', detail: '', state: 'todo' },
      { label: 'operators post one 48-byte share each', detail: '', state: 'todo' },
      { label: 'combine any t shares, recover every slot', detail: '', state: 'todo' },
    ];
  }

  function setStep(i: number, state: StepState, detail?: string): void {
    steps[i].state = state;
    if (detail !== undefined) steps[i].detail = detail;
  }

  /** Build (payload, summary) from the active scenario's fields. */
  function readFields(): { payload: string; summary: string } | null {
    const val = (sel: string) => host.querySelector<HTMLInputElement>(sel)?.value.trim() ?? '';
    if (scenario === 'bid') {
      const name = val('#pg-name') || 'anon';
      const amt = Number(val('#pg-amount'));
      if (!Number.isFinite(amt) || amt <= 0) return null;
      return { payload: JSON.stringify({ k: 'bid', name, amt }), summary: `${name} bid ${amt}` };
    }
    if (scenario === 'vote') {
      const name = val('#pg-name') || 'anon';
      const choice = host.querySelector<HTMLSelectElement>('#pg-choice')?.value ?? 'yes';
      return {
        payload: JSON.stringify({ k: 'vote', name, choice }),
        summary: `${name} voted ${choice}`,
      };
    }
    const text = val('#pg-secret');
    if (!text) return null;
    return { payload: text, summary: text };
  }

  async function seal(): Promise<void> {
    const fields = readFields();
    if (!fields) return;
    const sealBtn = host.querySelector<HTMLButtonElement>('#pg-seal')!;
    errorEl.hidden = true;
    sealBtn.disabled = true;
    sealBtn.setAttribute('aria-busy', 'true');
    sealBtn.textContent = 'sealing…';
    initSteps();
    try {
      // The real work happens in these awaits; the trace then replays the
      // stages with the genuine artifacts each one produced.
      setStep(0, 'active');
      const committee = await client.committee();

      // Bids and votes join the open round FOR THEIR SCENARIO (matched by
      // tag); capsules get their own tagged condition nobody else joins.
      let conditionId: string;
      if (scenario === 'note') {
        const delayVal = host.querySelector<HTMLSelectElement>('#pg-delay')?.value ?? '60';
        if (delayVal === 'custom') {
          const untilVal = host.querySelector<HTMLInputElement>('#pg-until')?.value ?? '';
          const until = new Date(untilVal);
          if (!untilVal || Number.isNaN(until.getTime()) || until.getTime() < Date.now() + 60_000) {
            throw new Error('pick a date at least a minute in the future');
          }
          conditionId = await client.condition({ at: until, tag: 'capsule' });
        } else {
          conditionId = await client.condition({ in: Number(delayVal), tag: 'capsule' });
        }
      } else {
        const open = await findOpenRound(roundTag());
        conditionId = open
          ? open.id
          : await client.condition({ in: chosenRoundSecs(), tag: roundTag() });
      }
      setStep(0, 'done',
        `digest ${committee.digest.slice(0, 12)}…, n=${committee.n} t=${committee.t} B=${committee.b}, re-checked against the wasm parse`);

      // Private capsules get an extra AES-GCM layer; the key rides only in
      // the share link, so the network reveal exposes ciphertext, not content.
      let payload: Uint8Array | string = fields.payload;
      let shareKey: string | undefined;
      const wantPrivate =
        scenario === 'note' && (host.querySelector<HTMLInputElement>('#pg-private')?.checked ?? false);
      if (wantPrivate) {
        const enc = await encryptPrivate(fields.payload);
        payload = enc.payload;
        shareKey = enc.key;
      }

      setStep(1, 'active');
      let sealed: { ctHash: string; sealedB64: string; code?: string };
      try {
        sealed = await client.seal(payload, conditionId);
      } catch (e) {
        // The round froze while we were sealing: start a fresh one.
        if (String(e).includes('closed') && scenario !== 'note') {
          conditionId = await client.condition({ in: chosenRoundSecs(), tag: roundTag() });
          sealed = await client.seal(payload, conditionId);
        } else {
          throw e;
        }
      }
      const wire = b64Bytes(sealed.sealedB64);
      const ct0hex = hex(wire.slice(5, 53));
      run = {
        conditionId,
        ctHash: sealed.ctHash,
        code: sealed.code,
        scenario,
        summary: fields.summary,
        shareKey,
        n: committee.n,
        t: committee.t,
        b: committee.b,
      };
      done = false;
      condition = null;
      form.hidden = true;
      renderLive();

      // Perceivable pacing only; every value shown is real.
      await sleep(500);
      setStep(1, 'done',
        `KEM header [k]₁ = ${ct0hex.slice(0, 20)}… (48 bytes), key mask 16 bytes, body ${wire.length - 73} bytes of keystream`);
      renderLive();
      await sleep(500);
      setStep(2, 'done', `ct_hash = sha256(wire) = ${sealed.ctHash.slice(0, 20)}…`);
      setStep(3, 'active');
      renderLive();
      await sleep(500);
      setStep(3, 'done', `stored. ${wire.length} ciphertext bytes are all that ever left this tab`);
      setStep(4, 'active');
      renderLive();
      startPolling();
    } catch (err) {
      form.hidden = false;
      liveEl.hidden = true;
      errorEl.textContent = String(err).includes('pick a date')
        ? `${String(err).replace('Error: ', '')}.`
        : `sealing failed. ${String(err)}. is the devnet up? try: just compose-up`;
      errorEl.hidden = false;
    } finally {
      sealBtn.disabled = false;
      sealBtn.removeAttribute('aria-busy');
      sealBtn.textContent = 'seal it';
    }
  }

  function startPolling(): void {
    stopPolling();
    pollTimer = window.setInterval(() => void poll(), POLL_MS);
    tickTimer = window.setInterval(renderLive, 1000);
    void poll();
  }

  function stopPolling(): void {
    if (pollTimer !== undefined) clearInterval(pollTimer);
    if (tickTimer !== undefined) clearInterval(tickTimer);
    pollTimer = tickTimer = undefined;
  }

  /** Feed live coordinator state into trace steps 5-7. */
  function syncSteps(): void {
    if (!run || !condition) return;
    const batch = condition.batches?.[0];
    const verified = batch?.verified_shares ?? 0;
    const status = condition.status;

    if (status === 'frozen' || status === 'stalled' || status === 'revealed') {
      const pre = batch?.predecrypt_ms;
      setStep(4, 'done',
        pre != null
          ? `positions assigned by hash order, padding to ${run.b}. FFT cross-terms precomputed in ${pre} ms, before any share existed (pipelined)`
          : `positions assigned by hash order, padding to ${run.b}. FFT cross-terms computing…`);
      setStep(5, verified >= run.t ? 'done' : 'active',
        `${verified} verified, ${run.t} needed. each checked publicly: e(pd_j, g₂) = Σ e(ct_i, v_j^i)`);
      if (verified >= run.t) {
        setStep(6, status === 'revealed' ? 'done' : 'active',
          status === 'revealed' && batch?.finalize_ms != null
            ? `Lagrange combine + finalize in ${batch.finalize_ms} ms. all ${run.b} slots opened at once`
            : 'Lagrange combine + finalize running…');
      }
    }
  }

  async function poll(): Promise<void> {
    if (!run || done) return;
    try {
      condition = await getCondition(run.conditionId);
    } catch {
      return; // transient; next poll retries
    }
    if (!watched.has(run.ctHash)) {
      watched.add(run.ctHash);
      rememberSeal({
        conditionId: run.conditionId,
        ctHash: run.ctHash,
        firesAt: condition.fires_at,
        role: 'sent',
        label: SCENARIO_LABEL[run.scenario],
      });
    }
    syncSteps();
    if (condition.status === 'revealed') {
      const reveal = await getReveal(run.conditionId).catch(() => null);
      if (reveal) {
        done = true;
        stopPolling();
        markSealRevealed(run.conditionId);
        const batch = condition.batches?.[0];
        setStep(5, 'done');
        setStep(6, 'done',
          batch?.finalize_ms != null
            ? `Lagrange combine + finalize in ${batch.finalize_ms} ms. all ${run.b} slots opened at once`
            : `all ${run.b} slots opened at once`);
        // Let the scene's reveal burst play before the results replace it.
        ceremony?.reveal();
        await sleep(750);
        renderRevealed(reveal);
        ceremony = null;
        return;
      }
    }
    renderLive();
  }

  function traceHtml(): string {
    const items = steps
      .map((s) => {
        const detail = s.detail
          ? `<span class="trace-detail mono">${esc(s.detail)}</span>`
          : '';
        return `<li class="trace-step trace-${s.state}">
          <span class="trace-marker" aria-hidden="true"></span>
          <span class="trace-body"><span class="trace-label">${esc(s.label)}</span>${detail}</span>
        </li>`;
      })
      .join('');
    return `<ol class="trace" aria-label="what is happening behind the scenes">${items}</ol>`;
  }

  /** Stage line + operator share dots + crypto trace while in flight.
   * The countdown line re-renders every second; the dots and trace only
   * re-render when their state actually changes, so their animations keep
   * their phase instead of restarting each tick. */
  function renderLive(): void {
    if (!run || done) return;
    const status = condition?.status ?? 'pending';
    const firesAt = condition?.fires_at ?? null;
    const secs = firesAt != null ? firesAt - Math.floor(Date.now() / 1000) : null;
    const batch = condition?.batches?.[0];
    const verified = batch?.verified_shares ?? 0;
    const others = Math.max(0, (condition?.real_count ?? 1) - 1);

    if (liveEl.hidden || !liveEl.querySelector('#pg-rest')) {
      liveEl.hidden = false;
      liveEl.innerHTML = `
        <div class="pg-stage">
          <div class="pg-sealed-row">
            <span class="sealed-label">sealed</span>
            <button type="button" class="hash-copy mono" data-copy="${esc(run.ctHash)}"
                    title="copy ciphertext hash">${esc(truncMiddle(run.ctHash, 14, 10))}</button>
          </div>
          <p class="pg-status" id="pg-head"></p>
          <div class="cer-mount" id="pg-ceremony"></div>
          <div id="pg-rest"></div>
          <p class="pg-links">
            <button type="button" class="btn" data-copy="${esc(sealLink(run))}">copy share link</button>
            <a class="link" href="#/condition/${encodeURIComponent(run.conditionId)}">watch it in the explorer</a>
          </p>
          <p class="field-hint">send the link to anyone. they get the countdown, then the content, on the same cue.</p>
        </div>
      `;
      wireCopy(liveEl);
      lastRest = '';
      // Fresh scene per run: encrypt -> split key -> hand shares to operators.
      ceremony?.destroy();
      ceremony = createCeremony({ n: run.n, t: run.t });
      liveEl.querySelector('#pg-ceremony')!.appendChild(ceremony.el);
      void ceremony.play();
    }

    ceremony?.setVerified(verified);

    const company =
      run.scenario !== 'note' && others > 0
        ? ` <span class="muted">(${others} other sealed ${others === 1 ? 'entry' : 'entries'} in this round)</span>`
        : '';
    let stage: string;
    if (status === 'stalled') {
      stage = `<span class="error">stalled. fewer than ${run.t} shares arrived in time. it recovers if late shares show up.</span>`;
    } else if (status === 'frozen') {
      stage = `batch frozen. operators are posting shares: <strong class="num">${verified}</strong> verified, <strong class="num">${run.t}</strong> needed`;
    } else if (secs != null && secs > 0) {
      stage = `sealed. reveals in <strong class="num accent">${esc(fmtCountdown(secs))}</strong>${company}`;
    } else {
      stage = 'cue reached. freezing the batch…';
    }
    liveEl.querySelector('#pg-head')!.innerHTML = stage;

    // Operator state now lives in the 3D scene (#pg-ceremony); this region
    // only carries the crypto trace, re-rendered when a step changes.
    const rest = traceHtml();
    if (rest !== lastRest) {
      liveEl.querySelector('#pg-rest')!.innerHTML = rest;
      lastRest = rest;
    }
  }

  /** Scenario-aware results: leaderboard for bids, tally for votes, the
   * plain secret for capsules. Everything comes from the actual reveal. */
  function resultsHtml(reveal: Reveal): string {
    if (!run) return '';
    // Private slots decrypt only for their link holders; ours renders from
    // the summary this tab kept, everyone else's stays a locked marker.
    let lockedOthers = 0;
    const entries: Entry[] = [];
    for (const s of reveal.slots) {
      if (s.is_dummy || !s.valid) continue;
      if (isPrivatePayload(payloadBytes(s.payload_b64))) {
        if (s.ct_hash === run.ctHash) {
          entries.push({ ctHash: s.ct_hash, kind: 'text', name: 'anon', text: run.summary });
        } else {
          lockedOthers += 1;
        }
        continue;
      }
      entries.push(parseEntry(s.ct_hash, decodePayload(s.payload_b64).text));
    }
    const mine = reveal.slots.find((s) => s.ct_hash === run!.ctHash);
    if (mine && !mine.valid) {
      return `<p class="pg-secret-out"><span class="error">your slot was flagged corrupt</span></p>`;
    }

    const you = (e: Entry) =>
      e.ctHash === run!.ctHash ? ' <span class="you-tag">you</span>' : '';
    const parts: string[] = [];

    const bids = entries
      .filter((e) => e.kind === 'bid')
      .sort((a, b) => (b.amt ?? 0) - (a.amt ?? 0));
    if (bids.length > 0) {
      const winner = bids[0];
      parts.push(`<p class="pg-secret-out">winner: ${esc(winner.name)} with ${winner.amt}${you(winner)}</p>`);
      parts.push(`<ol class="result-list">${bids
        .map((b) => `<li><span>${esc(b.name)}${you(b)}</span><span class="num">${b.amt}</span></li>`)
        .join('')}</ol>`);
    }

    const votes = entries.filter((e) => e.kind === 'vote');
    if (votes.length > 0) {
      const yes = votes.filter((v) => v.choice === 'yes').length;
      const no = votes.length - yes;
      const max = Math.max(yes, no, 1);
      const verdict = yes === no ? 'tied' : yes > no ? 'yes wins' : 'no wins';
      parts.push(`<p class="pg-secret-out">${verdict}: ${yes} yes, ${no} no</p>`);
      parts.push(`
        <div class="tally">
          <div class="tally-row"><span class="tally-label">yes</span>
            <div class="timing-track"><div class="timing-bar timing-bar-fin" style="width:${(yes / max) * 100}%"></div></div>
            <span class="num timing-ms">${yes}</span></div>
          <div class="tally-row"><span class="tally-label">no</span>
            <div class="timing-track"><div class="timing-bar timing-bar-pre" style="width:${(no / max) * 100}%"></div></div>
            <span class="num timing-ms">${no}</span></div>
        </div>`);
      const yours = votes.find((v) => v.ctHash === run!.ctHash);
      if (yours) parts.push(`<p class="muted">you voted ${esc(yours.choice ?? '')}.</p>`);
    }

    const texts = entries.filter((e) => e.kind === 'text');
    if (texts.length > 0 && (bids.length > 0 || votes.length > 0 || texts.length > 1)) {
      parts.push(`<ul class="result-list">${texts
        .map((t) => `<li><span>${esc(t.text ?? '')}${you(t)}</span></li>`)
        .join('')}</ul>`);
    } else if (texts.length === 1 && bids.length === 0 && votes.length === 0) {
      parts.push(`<p class="pg-secret-out">${esc(texts[0].text ?? '')}</p>`);
    }

    if (parts.length === 0) {
      parts.push(`<p class="pg-secret-out">${esc(run.summary)}</p>`);
    }
    if (lockedOthers > 0) {
      parts.push(`<p class="muted">${lockedOthers} private ${lockedOthers === 1 ? 'seal' : 'seals'} in
        this batch opened only for ${lockedOthers === 1 ? 'its' : 'their'} link holders.</p>`);
    }
    return parts.join('');
  }

  function renderRevealed(reveal: Reveal): void {
    if (!run) return;
    liveEl.innerHTML = `
      <div class="pg-stage pg-revealed reveal-in">
        <div class="pg-sealed-row">
          <span class="sealed-label sealed-label-open">revealed</span>
          <span class="mono muted">${esc(truncMiddle(run.ctHash, 14, 10))}</span>
        </div>
        ${resultsHtml(reveal)}
        <p class="muted">${run.shareKey
          ? 'revealed on cue, but the content stays private: only people with your share link can read it.'
          : 'everyone can read this now. before the cue, nobody could, operators included.'}</p>
        ${traceHtml()}
        <p class="pg-links">
          <button type="button" class="btn" data-copy="${esc(sealLink(run))}">copy share link</button>
          <a class="link" href="#/condition/${encodeURIComponent(run.conditionId)}">see the full reveal, shares and timings</a>
          <button type="button" class="btn" id="pg-again">seal another</button>
        </p>
      </div>
    `;
    lastRest = '';
    wireCopy(liveEl);
    liveEl.querySelector<HTMLButtonElement>('#pg-again')?.addEventListener('click', () => {
      run = null;
      ceremony?.destroy();
      ceremony = null;
      liveEl.hidden = true;
      liveEl.innerHTML = '';
      form.hidden = false;
      renderFields();
    });
  }

  return () => {
    stopPolling();
    clearInterval(roundTimer);
    ceremony?.destroy();
  };
}

/** Copy-to-clipboard with a 1.5s transient "copied" state. */
export function wireCopy(scope: HTMLElement): void {
  scope.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    const original = btn.innerHTML;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy ?? '');
        btn.classList.add('copied');
        btn.textContent = 'copied';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = original;
        }, 1500);
      } catch {
        // clipboard unavailable (http origin): leave the hash visible
      }
    });
  });
}
