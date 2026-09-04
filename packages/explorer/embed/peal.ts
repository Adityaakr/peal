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
  async seal(payload: string | Uint8Array, roundId: string): Promise<Seal> {
    const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    const params = await this.encryptor();
    const ciphertext_b64 = bytesToB64(params.seal(bytes));
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

  /** One seal, with its payload once the round has opened. */
  async getSeal(id: string): Promise<Seal> {
    return this.request(`/v1/seals/${encodeURIComponent(id)}`);
  }

  /** The opened payloads as bytes, in order, decoys already dropped. */
  async getPayloads(roundId: string): Promise<Uint8Array[]> {
    const seals = await this.listSeals(roundId);
    return seals
      .filter((s) => s.payload_b64)
      .map((s) => b64ToBytes(s.payload_b64 as string));
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
    return (await res.json()) as T;
  }
}

/** Ready to use against peal.network. `new Peal({ url })` for anywhere else. */
export const peal = new Peal();
export default peal;
