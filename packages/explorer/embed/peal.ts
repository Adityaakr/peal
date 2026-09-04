/**
 * peal.js — the whole client, in one file, from one URL.
 *
 *   import { peal } from 'https://peal.network/peal.js';
 *
 * Nothing to install. Two nouns: a ROUND is a moment and everything sealed to
 * it, a SEAL is one encrypted payload inside a round.
 *
 * The encryption runs here, in the caller's process. That is the only reason
 * this file exists rather than a page of fetch calls: everything else is plain
 * HTTP against /v1, and you can do it with curl.
 */
import { ensureWasm, b64ToBytes, bytesToB64 } from 'bte-sdk/wasm';

export type RoundStatus = 'open' | 'closing' | 'opened' | 'stalled';

export interface Round {
  id: string;
  status: RoundStatus;
  tag: string | null;
  opens_at: string | null;
  opens_at_unix?: number;
  opens_at_block?: { chain_id: number; height: number };
  seals: number;
  slots_including_decoys: number;
  /** Public from the moment the round is created, unlike anything sealed to it. */
  title: string | null;
  description: string | null;
  image_url: string | null;
  created_at: string;
  created_at_unix: number;
  opened_at: string | null;
}

export interface Seal {
  id: string;
  round_id: string;
  position: number | null;
  status: 'sealed' | 'opened';
  payload_b64?: string;
}

export interface CreateRoundOptions {
  /** Open this many seconds from now. */
  opensIn?: number;
  /** Or at an exact moment: a Date, an ISO string, or unix seconds. */
  opensAt?: Date | string | number;
  /** Or at a block height on a chain the network watches. */
  opensAtBlock?: { chainId: number; height: number };
  /** Your app\'s label: up to 32 chars of a-z 0-9 : _ -. It is how you list
   * your own rounds later, and it puts your app on the public board. */
  tag?: string;
  /** Retry safety. Send the same key twice and you get the same round back
   * rather than a second one. */
  idempotencyKey?: string;
  /** What this round is, for whoever opens it before it closes. PUBLIC: this is
   * the opposite of a sealed payload, and it is readable from creation. */
  title?: string;
  description?: string;
  /** An https picture. Anything else is refused rather than sanitised. */
  imageUrl?: string;
}

/** An error carrying the API\'s own machine-readable code. */
export class PealError extends Error {
  readonly code: string;
  readonly status: number;
  readonly field?: string;

  constructor(message: string, code: string, status: number, field?: string) {
    super(message);
    this.name = 'PealError';
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

const DEFAULT_URL = 'https://peal.network';

/**
 * Fixed widths a sealed payload is padded to.
 *
 * WHY THIS EXISTS. The ciphertext body is a keystream XOR over the plaintext,
 * so a sealed blob is `69 + payload` bytes and its LENGTH is public from the
 * moment it is submitted. Sealing a bid of "5" and a bid of "999999999999"
 * produces ciphertexts of 100 and 116 base64 characters, measured against the
 * live network. Anyone watching a round can therefore rank the bids by size
 * before anything opens, which is most of what a sealed bid auction is for.
 *
 * Padding to a bucket makes every small payload the same length on the wire.
 * It is a length policy over an existing cipher, not a new construction.
 */
const PAD_BUCKETS = [256, 1024, 4096, 16_384, 65_536];

/** Envelope version, so a reader can tell a padded payload from a raw one. */
const ENVELOPE_V1 = 1;
const ENVELOPE_HEADER = 5;

function padTo(payload: Uint8Array, requested?: number): Uint8Array {
  const needed = payload.length + ENVELOPE_HEADER;
  const width =
    requested ??
    PAD_BUCKETS.find((b) => b >= needed) ??
    // Past the largest bucket, hiding the length would mean sending megabytes
    // to conceal kilobytes. The caller keeps the exact size and knows it.
    needed;
  if (width < needed) {
    throw new PealError(
      `padTo ${width} is too small for a ${payload.length} byte payload`,
      'pad_too_small',
      0,
    );
  }
  const out = new Uint8Array(width);
  out[0] = ENVELOPE_V1;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, ENVELOPE_HEADER);
  return out;
}

/**
 * Undo the padding, or hand back what was there.
 *
 * A round can hold payloads sealed by other clients, including ones that never
 * used this envelope. Those are returned untouched rather than rejected: one
 * caller's format choice must not make somebody else's payload unreadable.
 */
function unpad(bytes: Uint8Array): Uint8Array {
  if (bytes.length < ENVELOPE_HEADER || bytes[0] !== ENVELOPE_V1) return bytes;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false);
  if (ENVELOPE_HEADER + length > bytes.length) return bytes;
  // The padding must be zero, or this is not an envelope this library wrote.
  for (let i = ENVELOPE_HEADER + length; i < bytes.length; i++) {
    if (bytes[i] !== 0) return bytes;
  }
  return bytes.slice(ENVELOPE_HEADER, ENVELOPE_HEADER + length);
}

export interface PealOptions {
  url?: string;
}

export class Peal {
  readonly url: string;
  private params: Promise<{ seal(bytes: Uint8Array): Uint8Array }> | null = null;

  constructor(opts: PealOptions = {}) {
    this.url = (opts.url ?? DEFAULT_URL).replace(/\/$/, '');
  }

  /** Name the moment things open. Nothing is encrypted yet. */
  async createRound(opts: CreateRoundOptions = {}): Promise<Round> {
    const body: Record<string, unknown> = {};
    if (opts.opensIn !== undefined) body.opens_in = opts.opensIn;
    if (opts.opensAt !== undefined) {
      body.opens_at =
        opts.opensAt instanceof Date ? opts.opensAt.toISOString() : opts.opensAt;
    }
    if (opts.opensAtBlock) {
      body.opens_at_block = {
        chain_id: opts.opensAtBlock.chainId,
        height: opts.opensAtBlock.height,
      };
    }
    if (body.opens_in === undefined && body.opens_at === undefined && !body.opens_at_block) {
      body.opens_in = 3600;
    }
    if (opts.tag) body.tag = opts.tag;
    if (opts.title) body.title = opts.title;
    if (opts.description) body.description = opts.description;
    if (opts.imageUrl) body.image_url = opts.imageUrl;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

    return this.request<Round>('/v1/rounds', { method: 'POST', headers, body: JSON.stringify(body) });
  }

  /** Your rounds, newest first. Pass a tag to see only your own. */
  async listRounds(
    opts: { tag?: string; status?: RoundStatus; limit?: number; cursor?: string } = {},
  ): Promise<{ data: Round[]; next_cursor: string | null; has_more: boolean }> {
    const q = new URLSearchParams();
    if (opts.tag) q.set('tag', opts.tag);
    if (opts.status) q.set('status', opts.status);
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.cursor) q.set('cursor', opts.cursor);
    const qs = q.toString();
    return this.request(`/v1/rounds${qs ? `?${qs}` : ''}`);
  }

  /** One round, at whatever stage it has reached. */
  async getRound(id: string): Promise<Round> {
    return this.request(`/v1/rounds/${encodeURIComponent(id)}`);
  }

  /**
   * Encrypt a payload and hand over the ciphertext.
   *
   * The plaintext never crosses the network. The returned id is the SHA-256 of
   * the ciphertext, so you can compute it yourself and never have to trust our
   * answer about which seal is yours.
   */
  async seal(
    payload: string | Uint8Array,
    roundId: string,
    opts: { padTo?: number } = {},
  ): Promise<Seal> {
    const raw = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    const params = await this.encryptor();
    // Padded by default. A caller who does not think about length leaks should
    // not get one; a caller who wants an exact width can ask for it.
    const ciphertext_b64 = bytesToB64(params.seal(padTo(raw, opts.padTo)));
    return this.request(`/v1/rounds/${encodeURIComponent(roundId)}/seals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ciphertext_b64 }),
    });
  }

  /** Every seal in a round: ids while it is open, payloads once it has opened. */
  async listSeals(roundId: string): Promise<Seal[]> {
    const body = await this.request<{ data: Seal[] }>(
      `/v1/rounds/${encodeURIComponent(roundId)}/seals`,
    );
    return body.data;
  }

  /**
   * Seal a payload until a moment, in one call.
   *
   * Encrypts here, creates a round holding just this seal, and returns its id
   * and a proof URL. `until` takes a Date, an ISO string or unix seconds.
   */
  async sealUntil(
    payload: string | Uint8Array,
    until: Date | string | number,
    opts: { tag?: string; title?: string; padTo?: number } = {},
  ): Promise<{ id: string; round_id: string; unlock_at: string; proof_url: string }> {
    const raw = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    const params = await this.encryptor();
    return this.request('/v1/seals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ciphertext_b64: bytesToB64(params.seal(padTo(raw, opts.padTo))),
        unlock_at: until instanceof Date ? until.toISOString() : until,
        tag: opts.tag,
        title: opts.title,
      }),
    });
  }

  /** What can be checked about one seal: the ordering commitment, the merkle
   * root, and whether the commitment preceded the reveal. */
  async getProof(sealId: string): Promise<Record<string, unknown>> {
    return this.request(`/v1/seals/${encodeURIComponent(sealId)}/proof`);
  }

  /** One seal, with its payload once the round has opened. */
  async getSeal(id: string): Promise<Seal> {
    return this.request(`/v1/seals/${encodeURIComponent(id)}`);
  }

  /** The opened payloads as bytes, in order, decoys already dropped. */
  async getPayloads(roundId: string): Promise<Uint8Array[]> {
    const seals = await this.listSeals(roundId);
    return seals
      .filter((s) => s.payload_b64)
      .map((s) => unpad(b64ToBytes(s.payload_b64 as string)));
  }

  /** Wait for a round to open, then return it. */
  async waitForOpen(
    roundId: string,
    opts: { timeoutMs?: number; everyMs?: number } = {},
  ): Promise<Round> {
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const everyMs = Math.max(1000, opts.everyMs ?? 2000);
    const until = Date.now() + timeoutMs;
    for (;;) {
      const round = await this.getRound(roundId);
      if (round.status === 'opened') return round;
      if (round.status === 'stalled') {
        throw new PealError(`round ${roundId} stalled`, 'round_stalled', 200);
      }
      if (Date.now() >= until) throw new PealError('timed out waiting', 'timeout', 0);
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }

  /** The public parameters, plus the committee shape. */
  async parameters(): Promise<{
    id: string;
    digest: string;
    parameters_b64: string;
    operators: number;
    threshold: number;
    batch_size: number;
  }> {
    return this.request('/v1/parameters');
  }

  /** Fetch the parameters once, verify their digest, and keep the encryptor. */
  private encryptor(): Promise<{ seal(bytes: Uint8Array): Uint8Array }> {
    this.params ??= (async () => {
      const [wasm, body] = await Promise.all([ensureWasm(), this.parameters()]);
      const params = new wasm.Params(b64ToBytes(body.parameters_b64));
      const info = params.info() as { digest: string };
      // The digest is checked against the one served alongside the bytes, so a
      // coordinator handing out parameters that do not match what it claims
      // fails here rather than producing ciphertexts nobody can open.
      if (info.digest !== body.digest) {
        throw new PealError(
          'the coordinator served parameters that do not match their digest',
          'parameters_mismatch',
          200,
        );
      }
      return params as unknown as { seal(bytes: Uint8Array): Uint8Array };
    })();
    return this.params;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.url}${path}`, init);
    if (!res.ok) {
      let code = `http_${res.status}`;
      let detail = `${init.method ?? 'GET'} ${path} failed with ${res.status}`;
      let field: string | undefined;
      try {
        const problem = (await res.json()) as { code?: string; detail?: string; field?: string };
        code = problem.code ?? code;
        detail = problem.detail ?? detail;
        field = problem.field;
      } catch {
        // A non-JSON error body is still an error; the status carries it.
      }
      throw new PealError(detail, code, res.status, field);
    }
    // A 200 is not proof of an answer: a static file server or a dev proxy that
    // does not forward /v1 can return one with a page in it. Failing here with
    // the status and the type says more than "unexpected end of JSON input".
    const text = await res.text();
    if (!text.trim()) {
      throw new PealError(`${path} returned ${res.status} with an empty body`, 'empty_response', res.status);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      const type = res.headers.get('content-type') ?? 'an unknown type';
      throw new PealError(
        `${path} returned ${res.status} as ${type}, not JSON: this server may not serve /v1`,
        'not_json',
        res.status,
      );
    }
  }
}

/** Ready to use against peal.network. `new Peal({ url })` for anywhere else. */
export const peal = new Peal();
export default peal;
