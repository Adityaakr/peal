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

/**
 * Refuse an option spelled the way the HTTP body spells it.
 *
 * Every option here is camelCase because the client is JavaScript, and the wire
 * format is snake_case because the API is HTTP. That is a reasonable pair of
 * conventions and a bad trap: the wrong spelling is not a type error, it is a
 * property nothing reads.
 */
function rejectSnakeCase(opts: Record<string, unknown>, pairs: Record<string, string>): void {
  for (const [wrong, right] of Object.entries(pairs)) {
    if (opts[wrong] !== undefined) {
      throw new PealError(
        `use ${right} rather than ${wrong}: this client takes camelCase options, ` +
          `the HTTP body takes snake_case`,
        'unknown_option',
        0,
      );
    }
  }
}

export class Peal {
  readonly url: string;
  private params: Promise<{ seal(bytes: Uint8Array): Uint8Array }> | null = null;

  constructor(opts: PealOptions = {}) {
    this.url = (opts.url ?? DEFAULT_URL).replace(/\/$/, '');
  }

  /** Name the moment things open. Nothing is encrypted yet. */
  async createRound(opts: CreateRoundOptions = {}): Promise<Round> {
    // The HTTP body is snake_case and this client is camelCase, so `opens_in`
    // is the natural thing to type and it used to be ignored in silence. The
    // one hour default then filled the gap, so a caller asking for sixty
    // seconds got an hour and no error. Say so instead.
    rejectSnakeCase(opts as Record<string, unknown>, {
      opens_in: 'opensIn',
      opens_at: 'opensAt',
      opens_at_block: 'opensAtBlock',
      image_url: 'imageUrl',
      idempotency_key: 'idempotencyKey',
    });
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

  /**
   * Encrypt a payload without submitting it.
   *
   * For callers who want to seal here and send the ciphertext through their own
   * transport: a queue, a signed request, an API playground. Padded exactly as
   * `seal` pads, so the length still says nothing about the contents.
   */
  async encrypt(payload: string | Uint8Array, opts: { padTo?: number } = {}): Promise<string> {
    const raw = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    const params = await this.encryptor();
    return bytesToB64(params.seal(padTo(raw, opts.padTo)));
  }

  /**
   * Encrypt a bid without submitting it.
   *
   * Same fixed width record `bid` builds, so what comes out is 320 bytes before
   * encryption whatever the amount inside it.
   */
  async encryptBid(auctionId: string, opts: BidOptions): Promise<string> {
    const params = await this.encryptor();
    return bytesToB64(params.seal(encodeBid(auctionId, opts)));
  }

  /** Every seal in a round: ids while it is open, payloads once it has opened. */
  async listSeals(roundId: string): Promise<Seal[]> {
    const body = await this.request<{ data: Seal[] | null }>(
      `/v1/rounds/${encodeURIComponent(roundId)}/seals`,
    );
    // `data` is null until the round opens, because a list of ids is the same
    // disclosure as a count of them. Empty rather than null here: a caller
    // looping over it should get nothing, not a crash. `getRound().status`
    // tells them why it is empty.
    return body.data ?? [];
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

  /** Open a sealed bid auction. Everything /#/create does, in one call. */
  async createAuction(opts: {
    title?: string;
    description?: string;
    imageUrl?: string;
    closesIn?: number;
    closesAt?: Date | string | number;
    currency?: string;
    decimals?: number;
    reserveMinor?: number;
    maximumMinor?: number;
    /** The seller's PUBLIC key. Generate the pair yourself and keep the private
     * half; sending it here would let this server read every contact detail. */
    contactPublicKey?: string;
    tag?: string;
  } = {}): Promise<Auction> {
    return this.request('/v1/auctions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: opts.title,
        description: opts.description,
        image_url: opts.imageUrl,
        closes_in: opts.closesIn,
        closes_at:
          opts.closesAt instanceof Date ? opts.closesAt.toISOString() : opts.closesAt,
        currency: opts.currency,
        decimals: opts.decimals,
        reserve_minor: opts.reserveMinor,
        maximum_minor: opts.maximumMinor,
        contact_public_key: opts.contactPublicKey,
        tag: opts.tag,
      }),
    });
  }

  async getAuction(id: string): Promise<Auction> {
    return this.request(`/v1/auctions/${encodeURIComponent(id)}`);
  }

  /**
   * Place a sealed bid.
   *
   * The amount is encoded into a fixed-width record and encrypted here, so what
   * reaches the network is 320 bytes regardless of the number inside it. Two
   * bids are indistinguishable on the wire until the auction opens.
   */
  async bid(auctionId: string, opts: BidOptions): Promise<Seal> {
    const params = await this.encryptor();
    const ciphertext_b64 = bytesToB64(params.seal(encodeBid(auctionId, opts)));
    return this.request(`/v1/auctions/${encodeURIComponent(auctionId)}/bids`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ciphertext_b64 }),
    });
  }

  /** The board once the auction has opened: every bid ranked, the queue the
   * rules allow to win, and anything discarded, with the reason. */
  async results(auctionId: string): Promise<AuctionResults> {
    return this.request(`/v1/auctions/${encodeURIComponent(auctionId)}/results`);
  }

  /** The currencies the API knows, searchable by code, name or symbol. Build
   * the same picker the create page has instead of hard-coding a dozen codes
   * and getting the decimals wrong. */
  async currencies(query = '', limit = 200): Promise<CurrencyInfo[]> {
    const q = new URLSearchParams();
    if (query) q.set('q', query);
    q.set('limit', String(limit));
    const body = await this.request<{ data: CurrencyInfo[] }>(`/v1/currencies?${q}`);
    return body.data;
  }

  /**
   * Whether a short link is free, and where it points if it is not.
   *
   * Checking only. Claiming a name is a permanent onchain write that can never
   * be undone or repointed, so it is done from your own key rather than by a
   * server acting on your behalf.
   */
  async checkName(name: string): Promise<{
    name: string;
    valid: boolean;
    available: boolean;
    url?: string;
    registry?: string;
  }> {
    return this.request(`/v1/names/${encodeURIComponent(name)}`);
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

// -------------------------------------------------------------- auctions ---

/** The fixed-width bid record, version 3. Mirrors packages/live/src/record.ts
 * and the decoder in the coordinator.
 *
 * Fixed width is the point: the ciphertext body is a keystream XOR, so a record
 * that changed size with the bid would put the bid's magnitude on the wire from
 * the moment it was submitted. Every bid is 320 bytes whether it is five
 * dollars or five hundred thousand, and whether or not it carries a contact. */
const BID_RECORD_V3 = 3;
const BID_RECORD_BYTES = 320;
const BID_ORIGIN_AT = BID_RECORD_BYTES - 12;
const MAX_BID_NAME_BYTES = 48;

export interface BidOptions {
  /** Integer MINOR units of the auction's currency: 12.50 in a 2 decimal
   * currency is 1250. Money in a float is a rounding error waiting to happen. */
  amountMinor: number;
  /** What to call this bidder on the board. Never unique, never trusted. */
  name?: string;
  /** Already encrypted to the auction's contact_public_key. Encrypt it before
   * it gets here: this record is published in full when the batch opens. */
  sealedContact?: Uint8Array;
}

function encodeBid(auctionId: string, opts: BidOptions): Uint8Array {
  const { amountMinor } = opts;
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new PealError('amountMinor must be a positive whole number', 'invalid_amount', 0);
  }
  const enc = new TextEncoder();
  const id = enc.encode(auctionId);
  const name = enc.encode(opts.name ?? '');
  const contact = opts.sealedContact ?? null;
  // The cap is BYTES, and it is checked rather than silently applied. Slicing
  // to 24 characters and then checking 48 bytes rejected a name of 24 emoji,
  // which is 96 bytes, while claiming the limit was characters. Quietly cutting
  // somebody's name is worse than telling them: it is the one field they chose.
  if (name.length > MAX_BID_NAME_BYTES) {
    throw new PealError(
      `that name is ${name.length} bytes; the limit is ${MAX_BID_NAME_BYTES}`,
      'invalid_name',
      0,
    );
  }
  const used = 10 + id.length + 1 + name.length + 1 + (contact?.length ?? 0);
  if (used > BID_ORIGIN_AT) {
    throw new PealError('the bid does not fit the record', 'bid_too_large', 0);
  }

  const out = new Uint8Array(BID_RECORD_BYTES);
  const view = new DataView(out.buffer);
  out[0] = BID_RECORD_V3;
  view.setBigUint64(1, BigInt(amountMinor), false);
  out[9] = id.length;
  out.set(id, 10);
  out[10 + id.length] = name.length;
  out.set(name, 11 + id.length);
  const contactAt = 11 + id.length + name.length;
  out[contactAt] = contact ? contact.length : 0;
  if (contact) out.set(contact, contactAt + 1);
  return out;
}

export interface Auction extends Omit<Round, 'seals' | 'opens_at' | 'opens_at_unix'> {
  closes_at: string | null;
  closes_at_unix?: number;
  bids: number;
  currency: string;
  decimals: number;
  reserve_minor: number | null;
  maximum_minor: number | null;
  contact_public_key: string | null;
  bids_url: string;
  results_url: string;
  /** A hosted page bidders can open, so an auction works before you have built
   * an interface for it. The whole auction rides in the URL fragment, which
   * browsers never send anywhere, so opening it tells nobody which auction it
   * is. Null when the auction has no title. */
  bid_url: string | null;
  /** Eight speakable characters over the terms. A seller reads them out and a
   * bidder checks them against their own screen: the only defence against a
   * link that was swapped on the way. */
  check_code: string | null;
  /** sha256 over the same terms, for anchoring them onchain yourself. */
  terms_hash: string | null;
}

// ------------------------------------------------- contact details --------

/**
 * Contact details a bidder gives the seller, and nobody else.
 *
 * THE PROBLEM. Everything in a bid is published when the batch opens: that is
 * what the reveal IS. So a plain contact field would be readable by every other
 * bidder the moment the auction closed. Hiding it in an interface and calling it
 * private would be exactly the claim this cannot afford to make.
 *
 * THE SHAPE. The seller makes a keypair. The public half goes on the auction, so
 * every bidder has it. The private half never leaves the seller's machine; a
 * bidder encrypts to the public half and only the seller can undo it.
 *
 * WHAT IS USED. WebCrypto's own ECDH P-256 and AES-GCM, joined by its own
 * deriveKey. No key derivation is written here.
 *
 * THE COST, WHICH IS REAL. The private key is the only copy. Lose it and every
 * contact detail is permanently unreadable, by everyone, including the seller.
 * There is no recovery and there cannot be: anything that let us recover it
 * would let us read them.
 */
export const MAX_CONTACT_BYTES = 64;
const CONTACT_PUBLIC_KEY_BYTES = 65;
const CONTACT_IV_BYTES = 12;
const CONTACT_TAG_BYTES = 16;
/** Fixed, so a bid carrying a contact is the same length as one that does not. */
export const SEALED_CONTACT_BYTES =
  CONTACT_PUBLIC_KEY_BYTES + CONTACT_IV_BYTES + MAX_CONTACT_BYTES + CONTACT_TAG_BYTES;

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

export interface SellerKeys {
  /** Goes on the auction as contactPublicKey. */
  publicKey: string;
  /** Stays with you. Nothing can read a contact without it, including us. */
  privateKey: JsonWebKey;
}

/** A keypair for one auction. Keep the private half; there is no second copy. */
export async function generateSellerKeys(): Promise<SellerKeys> {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    publicKey: bytesToB64url(raw),
    privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
}

/** Whether a string is shaped like a seller's public key. Checked before use,
 * because it arrives inside an auction somebody else created. */
export function isSellerKey(key: string): boolean {
  try {
    return b64urlToBytes(key.trim()).length === CONTACT_PUBLIC_KEY_BYTES;
  } catch {
    return false;
  }
}

/** Encrypt a contact so only the seller can read it.
 *
 * The ephemeral key is per bid and thrown away, which is what stops two bids
 * from the same person being linkable by anything in the blob. The text is
 * padded to the cap before encryption, so its length says nothing either. */
export async function sealContact(
  sellerPublicKey: string,
  text: string,
): Promise<Uint8Array> {
  const plain = new TextEncoder().encode(text);
  if (plain.length > MAX_CONTACT_BYTES - 1) {
    throw new PealError(
      `contact details exceed ${MAX_CONTACT_BYTES - 1} bytes`,
      'contact_too_long',
      0,
    );
  }
  const seller = await crypto.subtle.importKey(
    'raw',
    b64urlToBytes(sellerPublicKey) as BufferSource,
    ECDH,
    false,
    [],
  );
  const ephemeral = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
  const shared = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: seller },
    ephemeral.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(CONTACT_IV_BYTES));
  const padded = new Uint8Array(MAX_CONTACT_BYTES);
  padded[0] = plain.length;
  padded.set(plain, 1);
  const body = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, shared, padded as BufferSource),
  );
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const out = new Uint8Array(SEALED_CONTACT_BYTES);
  out.set(ephRaw, 0);
  out.set(iv, CONTACT_PUBLIC_KEY_BYTES);
  out.set(body, CONTACT_PUBLIC_KEY_BYTES + CONTACT_IV_BYTES);
  return out;
}

/** Read a contact back, with the key only the seller has.
 *
 * Null rather than throwing for anything that does not open: a board is built
 * from strangers' bids and one unreadable blob must not stop the rest. */
export async function openContact(
  privateKey: JsonWebKey,
  sealed: Uint8Array,
): Promise<string | null> {
  if (sealed.length !== SEALED_CONTACT_BYTES) return null;
  try {
    const mine = await crypto.subtle.importKey('jwk', privateKey, ECDH, false, ['deriveKey']);
    const theirs = await crypto.subtle.importKey(
      'raw',
      sealed.subarray(0, CONTACT_PUBLIC_KEY_BYTES) as BufferSource,
      ECDH,
      false,
      [],
    );
    const shared = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: theirs },
      mine,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const iv = sealed.subarray(CONTACT_PUBLIC_KEY_BYTES, CONTACT_PUBLIC_KEY_BYTES + CONTACT_IV_BYTES);
    const body = sealed.subarray(CONTACT_PUBLIC_KEY_BYTES + CONTACT_IV_BYTES);
    const padded = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, shared, body as BufferSource),
    );
    const len = padded[0] ?? 0;
    if (len === 0 || len > MAX_CONTACT_BYTES - 1) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(padded.subarray(1, 1 + len));
  } catch {
    return null;
  }
}

function bytesToB64url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return b64ToBytes(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

export interface CurrencyInfo {
  code: string;
  name: string;
  decimals: number;
  symbol: string | null;
}

export interface AuctionBid {
  ct_hash: string;
  position: number;
  name: string;
  amount_minor: number;
  meets_reserve: boolean;
  within_maximum: boolean;
  sealed_contact_b64: string | null;
  bid_in: { currency: string; amount_minor: number; decimals: number } | null;
}

export interface AuctionResults {
  auction_id: string;
  status: RoundStatus;
  currency?: string;
  decimals?: number;
  /** Every readable bid, ranked. */
  bids: AuctionBid[] | null;
  /** Only the ones the rules allow to win, in order. */
  queue?: AuctionBid[];
  winner?: AuctionBid | null;
  decoys?: number;
  discarded?: { ct_hash: string; reason: string }[];
}

/** Ready to use against peal.network. `new Peal({ url })` for anywhere else. */
export const peal = new Peal();
export default peal;
