// bte-sdk: seal now. reveal on cue.
//
// v0 trust model: the committee comes from a dealer-trusted ceremony.

import { bytesToB64, b64ToBytes, ensureWasm } from './wasm.js';
import type { Params } from './generated/seal/bte_wasm.js';
import { anchorCommit, type AnchorConfig } from './anchor.js';

export * from './anchor.js';

/** Public devnet placeholder — no public devnet is live yet. Point BteClient
 * (or BTE_DEVNET_URL) at your own stack, e.g. `just compose-up` on
 * http://localhost:8080. */
export const DEVNET_URL = 'https://devnet.bte.invalid';

/** Mirrors bte_crypto::MAX_PAYLOAD_BYTES. Policy, not a crypto limit: the FO
 * body is a keystream XOR, and threshold work is over 48-byte headers only. */
export const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

export interface CommitteeInfo {
  id: string;
  n: number;
  t: number;
  b: number;
  digest: string;
}

export interface ConditionStatus {
  id: string;
  status: 'pending' | 'frozen' | 'revealed' | 'stalled';
  kind: string;
  firesAt: number | null;
  ciphertextCount: number;
  realCount: number;
  batches: Array<{
    batchId: number;
    predecryptMs: number | null;
    finalizeMs: number | null;
  }>;
}

export interface RevealSlot {
  position: number;
  ctHash: string;
  isDummy: boolean;
  valid: boolean;
  payload: Uint8Array;
  /** UTF-8 decode of payload when it is valid text, else undefined. */
  text?: string;
}

export interface Reveal {
  conditionId: string;
  revealedAt: number;
  merkleRoot: string;
  slots: RevealSlot[];
  shares: Array<{
    batchId: number;
    operatorId: number;
    verified: boolean;
    submittedAtMs: number;
  }>;
}

export interface BteClientOptions {
  /** Coordinator base URL. Defaults to BTE_DEVNET_URL env, then DEVNET_URL. */
  url?: string;
  /** Committee id; defaults to the coordinator's default committee. */
  committeeId?: string;
  /** Injectable fetch (tests). */
  fetch?: typeof fetch;
}

export class BteClient {
  readonly url: string;
  readonly committeeId: string;
  private readonly fetchImpl: typeof fetch;
  private paramsPromise: Promise<{ params: Params; info: CommitteeInfo }> | null = null;

  constructor(opts: BteClientOptions = {}) {
    const envUrl =
      typeof process !== 'undefined' ? process.env?.BTE_DEVNET_URL : undefined;
    this.url = (opts.url ?? envUrl ?? DEVNET_URL).replace(/\/$/, '');
    this.committeeId = opts.committeeId ?? 'default';
    // Bind to globalThis: a bare `fetch` reference throws "Illegal
    // invocation" in browsers when called as a method.
    this.fetchImpl = opts.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  private async request(path: string, init?: RequestInit): Promise<any> {
    const resp = await this.fetchImpl(`${this.url}${path}`, {
      headers: { 'content-type': 'application/json' },
      ...init,
    });
    const contentType = resp.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error(
        `${this.url || 'this origin'} answered ${path} with ` +
          `${contentType.split(';')[0] || 'no content type'}, not JSON. ` +
          `that is not a bte coordinator; check the url/port.`,
      );
    }
    if (!resp.ok) {
      let detail = '';
      try {
        detail = ((await resp.json()) as any).error ?? '';
      } catch {
        // non-JSON error body
      }
      const err = new Error(`bte coordinator ${resp.status}: ${detail || path}`);
      (err as any).status = resp.status;
      throw err;
    }
    return resp.json();
  }

  /** Fetch + cache committee params (parsed and subgroup-checked in wasm). */
  async committee(): Promise<CommitteeInfo> {
    return (await this.ensureParams()).info;
  }

  private ensureParams(): Promise<{ params: Params; info: CommitteeInfo }> {
    if (!this.paramsPromise) {
      this.paramsPromise = (async () => {
        const [wasm, body] = await Promise.all([
          ensureWasm(),
          this.request(`/v0/committees/${this.committeeId}`),
        ]);
        const params = new wasm.Params(b64ToBytes(body.params_b64));
        const info = params.info() as { n: number; t: number; b: number; digest: string };
        if (info.digest !== body.params_digest) {
          throw new Error(
            'committee params digest mismatch: coordinator served inconsistent params',
          );
        }
        return {
          params,
          info: {
            id: body.id,
            n: info.n,
            t: info.t,
            b: info.b,
            digest: info.digest,
          },
        };
      })();
      this.paramsPromise.catch(() => {
        this.paramsPromise = null; // allow retry after transient failure
      });
    }
    return this.paramsPromise;
  }

  /** Create a reveal condition: {at: Date|unixSeconds}, {in: seconds}, or
   * {atBlock: {chainId, height}}. An optional {tag} labels the condition so
   * your app can find its own rounds later (<=32 chars of [a-z0-9:_-]). */
  async condition(when: {
    at?: Date | number;
    in?: number;
    atBlock?: { chainId: number; height: number };
    tag?: string;
  }): Promise<string> {
    const info = await this.committee();
    const body: Record<string, unknown> = { committee_id: info.id };
    if (when.tag !== undefined) body.tag = when.tag;
    if (when.atBlock !== undefined) {
      body.kind = 'at_block';
      body.chain_id = when.atBlock.chainId;
      body.height = when.atBlock.height;
    } else if (when.at !== undefined) {
      body.fires_at =
        when.at instanceof Date ? Math.round(when.at.getTime() / 1000) : when.at;
    } else if (when.in !== undefined) {
      body.in_secs = Math.round(when.in);
    } else {
      throw new Error('condition needs {at} or {in}');
    }
    const resp = await this.request('/v0/conditions', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return resp.id;
  }

  /**
   * Seal a payload (string or bytes, max 4096 bytes) to a condition.
   * Encryption happens client-side in wasm; only the ciphertext leaves.
   */
  async seal(
    payload: Uint8Array | string,
    conditionId: string,
    opts: { anchor?: AnchorConfig } = {},
  ): Promise<{ ctHash: string; sealedB64: string; code?: string }> {
    const bytes =
      typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    if (bytes.length > MAX_PAYLOAD_BYTES) {
      throw new Error(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }
    const { params } = await this.ensureParams();
    const sealed = params.seal(bytes);
    const sealedB64 = bytesToB64(sealed);
    const resp = await this.request('/v0/ciphertexts', {
      method: 'POST',
      body: JSON.stringify({ condition_id: conditionId, sealed_blob_b64: sealedB64 }),
    });
    if (opts.anchor) {
      await anchorCommit(opts.anchor, conditionId, resp.ct_hash);
    }
    return { ctHash: resp.ct_hash, sealedB64, code: resp.code };
  }

  async status(conditionId: string): Promise<ConditionStatus> {
    const body = await this.request(`/v0/conditions/${conditionId}`);
    return {
      id: body.id,
      status: body.status,
      kind: body.kind,
      firesAt: body.fires_at,
      ciphertextCount: body.ciphertext_count,
      realCount: body.real_count,
      batches: (body.batches ?? []).map((b: any) => ({
        batchId: b.batch_id,
        predecryptMs: b.predecrypt_ms,
        finalizeMs: b.finalize_ms,
      })),
    };
  }

  /** The reveal, or null while the condition has not revealed yet. */
  async reveal(conditionId: string): Promise<Reveal | null> {
    let body: any;
    try {
      body = await this.request(`/v0/reveals/${conditionId}`);
    } catch (e: any) {
      if (e.status === 404) return null;
      throw e;
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return {
      conditionId,
      revealedAt: body.revealed_at,
      merkleRoot: body.merkle_root,
      slots: (body.slots ?? []).map((s: any): RevealSlot => {
        const payload = b64ToBytes(s.payload_b64);
        let text: string | undefined;
        try {
          text = decoder.decode(payload);
        } catch {
          text = undefined;
        }
        return {
          position: s.position,
          ctHash: s.ct_hash,
          isDummy: s.is_dummy,
          valid: s.valid,
          payload,
          text,
        };
      }),
      shares: (body.shares ?? []).map((s: any) => ({
        batchId: s.batch_id,
        operatorId: s.operator_id,
        verified: s.verified,
        submittedAtMs: s.submitted_at_ms,
      })),
    };
  }

  /** Poll until revealed (or stalled/timeout). */
  async waitForReveal(
    conditionId: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<Reveal> {
    const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
    const pollMs = opts.pollMs ?? 1000;
    for (;;) {
      const reveal = await this.reveal(conditionId);
      if (reveal) return reveal;
      if (Date.now() > deadline) {
        const status = await this.status(conditionId).catch(() => null);
        throw new Error(
          `timed out waiting for reveal of ${conditionId}` +
            (status ? ` (status: ${status.status})` : ''),
        );
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

// Free-function forms of the core API.
export function condition(
  when: { at?: Date | number; in?: number },
  client: BteClient,
): Promise<string> {
  return client.condition(when);
}

export function seal(
  payload: Uint8Array | string,
  conditionId: string,
  client: BteClient,
): Promise<{ ctHash: string; sealedB64: string }> {
  return client.seal(payload, conditionId);
}

export function status(conditionId: string, client: BteClient): Promise<ConditionStatus> {
  return client.status(conditionId);
}

export function reveal(conditionId: string, client: BteClient): Promise<Reveal | null> {
  return client.reveal(conditionId);
}
