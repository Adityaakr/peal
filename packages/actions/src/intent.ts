/** The intent: what an agent wants done, and what the world is allowed to see
 * about it before it happens.
 *
 * Peal's guarantee is narrow and worth stating precisely, because the whole
 * design follows from it:
 *
 *   Intent contents remain encrypted until batch inclusion and ordering are
 *   committed.
 *
 * That is NOT permanent privacy. After the threshold reveal the executor reads
 * the payload, the liquidity API sees a quote request, and the settled
 * transaction is public forever. See docs/private-actions-privacy-model.md.
 *
 * The split below is the privacy boundary made structural. Everything in
 * `IntentEnvelope` is public the moment the intent is submitted. Everything in
 * `SwapPayload` is inside the ciphertext. A field in the wrong half is a leak,
 * so the envelope is kept deliberately, almost uselessly minimal: it carries
 * nothing about WHAT the action is — not the action type, not the token pair,
 * not the amount, not the recipient.
 */

import { canonicalize } from './canonical.js';
import { sha256Hex } from './hash.js';

/** Bumped when the envelope layout or the signing preimage changes. Signatures
 * bind this, so an old client cannot have its intent reinterpreted under new
 * rules. */
export const PROTOCOL_VERSION = 1;

/** Bumped independently when the encrypted payload layout changes, so new
 * action types can land without invalidating envelope signatures. */
export const PAYLOAD_VERSION = 1;

/** Hex string, lowercase, 0x-prefixed. */
export type Hex = `0x${string}`;

/**
 * The public half. Visible to the coordinator, to other agents, and to anyone
 * reading the API from the moment of submission.
 *
 * `executionDomain` is the one deliberate metadata leak: the coordinator needs
 * a chain id to route a revealed intent to the right adapter, and it is bound
 * into the signature so it cannot be swapped. It tells an observer which chain
 * an agent is acting on, and nothing else. Documented rather than hidden.
 */
export interface IntentEnvelope {
  protocolVersion: number;
  intentId: string;
  /** Which committee's public params the payload was encrypted under: the
   * params digest. Peal has no epochs, so this is the key identity. */
  encryptionKeyId: string;
  /** sha256 of the sealed ciphertext bytes. This is what the signature binds
   * and what the batch commitment orders. */
  ciphertextHash: string;
  /** Anti-replay, agent-chosen, unique per signer. */
  nonce: string;
  createdAt: number;
  expiresAt: number;
  /** The agent's address. Pseudonymous by construction: Peal never learns who
   * owns it and never holds its key. */
  pseudonymousSigner: Hex;
  /** Chain id the action executes on. Metadata leak, see above. */
  executionDomain: number;
  signature?: Hex;
}

/** The private half: everything that would let a competitor copy the strategy
 * or a searcher build a sandwich. Never leaves the agent unencrypted. */
export interface SwapPayload {
  payloadVersion: number;
  actionType: 'swap';
  originChainId: number;
  destinationChainId: number;
  sellToken: Hex;
  buyToken: Hex;
  /** Base units, as a decimal string — these are uint256 values and must not
   * round-trip through a JS number. */
  sellAmount: string;
  /** The floor the agent signed. Authoritative: a quote below this is rejected
   * no matter what the liquidity provider returns. */
  minimumBuyAmount: string;
  recipient: Hex;
  refundAddress: Hex;
  /** Unix seconds. Independent of the envelope expiry: the envelope governs
   * submission, this governs execution. */
  deadline: number;
  /** Base units of the sell token the agent will tolerate in total fees. */
  maximumFee: string;
  preferredAdapters: string[];
  excludedAdapters: string[];
  allowPartialFill: boolean;
  /** When true, the action must not be broadcast through a public RPC. If no
   * private submission provider is configured, execution fails rather than
   * silently degrading. */
  privateSubmissionRequired: boolean;
  /** Opaque agent-side annotations. Encrypted like everything else here, but
   * it IS revealed at reveal time — do not put long-lived secrets in it. */
  agentMetadata?: Record<string, string>;
}

export type ActionPayload = SwapPayload;

/** Fields an envelope signature commits to, in a fixed order.
 *
 * Deliberately not "the whole envelope": `signature` cannot sign itself, and
 * pinning an explicit list means adding a field later cannot silently widen or
 * narrow what was signed. */
export interface SigningPreimage {
  domain: 'peal.private-actions';
  protocolVersion: number;
  intentId: string;
  encryptionKeyId: string;
  ciphertextHash: string;
  nonce: string;
  expiresAt: number;
  executionDomain: number;
}

export function signingPreimage(env: IntentEnvelope): SigningPreimage {
  return {
    domain: 'peal.private-actions',
    protocolVersion: env.protocolVersion,
    intentId: env.intentId,
    encryptionKeyId: env.encryptionKeyId,
    ciphertextHash: env.ciphertextHash,
    nonce: env.nonce,
    expiresAt: env.expiresAt,
    executionDomain: env.executionDomain,
  };
}

/** Canonical bytes for a payload, as sealed. The recipient re-derives this to
 * check that what came out of the batch is what the agent put in. */
export function encodePayload(p: ActionPayload): Uint8Array {
  return new TextEncoder().encode(canonicalize(p));
}

export function decodePayload(bytes: Uint8Array): ActionPayload {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return validatePayload(parsed);
}

/** Hash of the revealed payload, for the receipt. Lets a receipt prove which
 * payload executed without republishing the payload itself. */
export async function payloadHash(p: ActionPayload): Promise<string> {
  return sha256Hex(encodePayload(p));
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^[0-9]+$/;

function bad(msg: string): never {
  throw new Error(`invalid intent payload: ${msg}`);
}

/** Parse hostile bytes into a payload, or throw.
 *
 * This runs on the executor over data that was encrypted by someone else, so
 * every field is treated as attacker-chosen even though it was authenticated:
 * a valid signature proves who sent it, not that they meant well. */
export function validatePayload(v: unknown): ActionPayload {
  if (typeof v !== 'object' || v === null) bad('not an object');
  const p = v as Record<string, unknown>;

  if (p.payloadVersion !== PAYLOAD_VERSION) bad(`unsupported payloadVersion ${String(p.payloadVersion)}`);
  if (p.actionType !== 'swap') bad(`unsupported actionType ${String(p.actionType)}`);

  for (const k of ['originChainId', 'destinationChainId', 'deadline'] as const) {
    if (typeof p[k] !== 'number' || !Number.isInteger(p[k]) || (p[k] as number) < 0) bad(`${k} must be a non-negative integer`);
  }
  for (const k of ['sellToken', 'buyToken', 'recipient', 'refundAddress'] as const) {
    if (typeof p[k] !== 'string' || !ADDRESS.test(p[k] as string)) bad(`${k} must be an address`);
  }
  // Amounts are uint256. A JS number would silently lose precision above 2^53,
  // which for an 18-decimal token is a very ordinary trade size.
  for (const k of ['sellAmount', 'minimumBuyAmount', 'maximumFee'] as const) {
    if (typeof p[k] !== 'string' || !UINT.test(p[k] as string)) bad(`${k} must be a decimal uint string`);
  }
  if (BigInt(p.sellAmount as string) === 0n) bad('sellAmount must be non-zero');
  for (const k of ['preferredAdapters', 'excludedAdapters'] as const) {
    if (!Array.isArray(p[k]) || (p[k] as unknown[]).some((x) => typeof x !== 'string')) bad(`${k} must be a string array`);
  }
  for (const k of ['allowPartialFill', 'privateSubmissionRequired'] as const) {
    if (typeof p[k] !== 'boolean') bad(`${k} must be a boolean`);
  }
  if (p.agentMetadata !== undefined) {
    if (typeof p.agentMetadata !== 'object' || p.agentMetadata === null || Array.isArray(p.agentMetadata)) {
      bad('agentMetadata must be an object');
    }
    for (const [, val] of Object.entries(p.agentMetadata as Record<string, unknown>)) {
      if (typeof val !== 'string') bad('agentMetadata values must be strings');
    }
  }

  return p as unknown as ActionPayload;
}

/** Envelope checks that need no network and no signature verification. The
 * signature is checked separately in sign.ts. */
export function validateEnvelope(env: IntentEnvelope, nowSecs: number): void {
  if (env.protocolVersion !== PROTOCOL_VERSION) bad(`unsupported protocolVersion ${env.protocolVersion}`);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(env.intentId)) bad('intentId must be 8-64 url-safe chars');
  if (!/^[0-9a-f]{64}$/.test(env.ciphertextHash)) bad('ciphertextHash must be 32 hex bytes');
  if (!/^[0-9a-f]{64}$/.test(env.encryptionKeyId)) bad('encryptionKeyId must be 32 hex bytes');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(env.nonce)) bad('nonce must be 8-64 url-safe chars');
  if (!ADDRESS.test(env.pseudonymousSigner)) bad('pseudonymousSigner must be an address');
  if (!Number.isInteger(env.executionDomain) || env.executionDomain <= 0) bad('executionDomain must be a chain id');
  if (!Number.isInteger(env.expiresAt) || env.expiresAt <= nowSecs) bad('intent has expired');
  if (!Number.isInteger(env.createdAt) || env.createdAt > nowSecs + 300) bad('createdAt is in the future');
}
