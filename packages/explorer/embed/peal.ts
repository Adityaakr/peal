/**
 * peal.js — the whole client, in one file, from one URL.
 *
 *   import { peal } from 'https://peal.network/peal.js';
 *
 * There is nothing to install and no package to trust. Two of the three calls
 * here are plain HTTP you could make with curl; the third does the encryption,
 * and it does it in the caller's process, which is why it needs code at all.
 *
 * Everything is namespaced under one object so a script tag and an import both
 * read the same way.
 */
import { BteClient } from 'bte-sdk';

export interface SealResult {
  /** The coordinator's name for this ciphertext. Yours to keep: it is how you
   * find your own submission in the reveal. */
  ctHash: string;
  /** The ciphertext itself, exactly as it was sent. Keep it if you want to
   * recompute the hash yourself rather than take ours. */
  sealedB64: string;
}

export interface RevealSlot {
  position: number;
  ct_hash: string;
  payload_b64: string;
  /** True for the decoys the coordinator adds to fill a batch, so a round with
   * three submissions does not announce that it had three. */
  is_dummy: boolean;
}

export interface Reveal {
  condition_id: string;
  slots: RevealSlot[];
  merkle_root: string;
}

export interface ConditionOptions {
  /** Open this many seconds from now. */
  in_secs?: number;
  /** Or open at this absolute unix second. */
  fires_at?: number;
  /** Or open at a block height: pass kind 'at_block' with chain_id + height. */
  kind?: 'at_time' | 'at_block';
  chain_id?: number;
  height?: number;
  /** Your app's label. Not interpreted by the network; it is how you find your
   * own conditions, and how your app appears on the public board. */
  tag?: string;
}

export interface PealOptions {
  /** Where the network lives. Defaults to the origin this file was served
   * from, which is the right answer whenever you loaded it from peal.network. */
  url?: string;
}

const DEFAULT_URL = 'https://peal.network';

export class Peal {
  readonly url: string;
  private client: BteClient;

  constructor(opts: PealOptions = {}) {
    this.url = (opts.url ?? DEFAULT_URL).replace(/\/$/, '');
    this.client = new BteClient({ url: this.url });
  }

  /** Name the moment things open. Nothing is encrypted yet. */
  async createCondition(opts: ConditionOptions = {}): Promise<{ id: string; fires_at?: number }> {
    const body: ConditionOptions = { ...opts };
    if (body.in_secs === undefined && body.fires_at === undefined && body.kind !== 'at_block') {
      body.in_secs = 3600;
    }
    const res = await fetch(`${this.url}/v0/conditions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await errorText(res, 'could not create the condition'));
    return (await res.json()) as { id: string; fires_at?: number };
  }

  /**
   * Encrypt a payload and hand over the ciphertext.
   *
   * The encryption happens here, in your process. The plaintext never crosses
   * the network, so there is no point at which the coordinator, the operators
   * or anyone watching the wire could read it.
   */
  async seal(payload: string | Uint8Array, conditionId: string): Promise<SealResult> {
    const { ctHash, sealedB64 } = await this.client.seal(payload, conditionId);
    return { ctHash, sealedB64 };
  }

  /** Where a condition has got to. */
  async getCondition(id: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.url}/v0/conditions/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(await errorText(res, 'no such condition'));
    return (await res.json()) as Record<string, unknown>;
  }

  /** Everything sealed to a condition, or null while it is still closed. */
  async getReveal(conditionId: string): Promise<Reveal | null> {
    const res = await fetch(`${this.url}/v0/reveals/${encodeURIComponent(conditionId)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await errorText(res, 'could not read the reveal'));
    return (await res.json()) as Reveal;
  }

  /** The payloads only, decoys dropped and bytes decoded. */
  async getPayloads(conditionId: string): Promise<Uint8Array[]> {
    const reveal = await this.getReveal(conditionId);
    if (!reveal) return [];
    return reveal.slots
      .filter((s) => !s.is_dummy)
      .sort((a, b) => a.position - b.position)
      .map((s) => Uint8Array.from(atob(s.payload_b64), (c) => c.charCodeAt(0)));
  }

  /** Wait for a condition to open. Polls; resolves with the reveal. */
  async waitForReveal(
    conditionId: string,
    opts: { timeoutMs?: number; everyMs?: number } = {},
  ): Promise<Reveal> {
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const everyMs = Math.max(1000, opts.everyMs ?? 2000);
    const until = Date.now() + timeoutMs;
    for (;;) {
      const reveal = await this.getReveal(conditionId);
      if (reveal) return reveal;
      if (Date.now() >= until) throw new Error('timed out waiting for the reveal');
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }
}

async function errorText(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `${fallback} (${res.status})`;
  } catch {
    return `${fallback} (${res.status})`;
  }
}

/** Ready to use against peal.network. Call `new Peal({ url })` for another. */
export const peal = new Peal();
export default peal;
