/** Agent signatures.
 *
 * Two distinct things get signed, at two different times, and conflating them
 * would be a real vulnerability:
 *
 *  1. The INTENT ENVELOPE, signed before submission. It binds the agent to a
 *     specific ciphertext without revealing what is in it. Peal checks this to
 *     know the ciphertext was not forged or replayed.
 *
 *  2. The EXECUTION AUTHORIZATION, signed after reveal, once the agent has seen
 *     the actual quote. It binds the agent to one concrete transaction.
 *
 * Signing (1) is not consent to (2). An agent that signs an intent has NOT
 * pre-approved whatever quote comes back — that is the entire point of the
 * authorization handoff, and it is why Peal never holds an agent key.
 *
 * EIP-712 throughout, because the repo is already EVM/viem shaped and because a
 * wallet showing a typed struct is the difference between an agent operator
 * seeing "swap 50000 USDC, min out 14.2 ETH" and seeing a hex blob.
 */

import {
  hashTypedData,
  recoverTypedDataAddress,
  verifyTypedData,
  type Address,
  type Hex,
  type TypedDataDomain,
} from 'viem';
import type { IntentEnvelope } from './intent.js';

/** Domain separator. `chainId` is the execution domain, so a signature for one
 * chain cannot be replayed on another. No `verifyingContract` in V1: the
 * DirectAgentSigner path has no settlement contract to bind to. When the
 * ConstrainedExecutorContract provider lands it must be added here, which will
 * change the digest — hence `version`. */
export function intentDomain(chainId: number): TypedDataDomain {
  return { name: 'Peal Private Actions', version: '1', chainId };
}

export const INTENT_TYPES = {
  Intent: [
    { name: 'protocolVersion', type: 'uint16' },
    { name: 'intentId', type: 'string' },
    { name: 'encryptionKeyId', type: 'bytes32' },
    { name: 'ciphertextHash', type: 'bytes32' },
    { name: 'nonce', type: 'string' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'executionDomain', type: 'uint256' },
  ],
} as const;

/** What the agent authorizes AFTER seeing the real quote.
 *
 * `quoteHash` and `callHash` are what make this specific: they pin the exact
 * quote and the exact calldata/target/value. A different quote, or the same
 * quote with one byte of calldata changed, produces a different digest and the
 * authorization does not verify. */
export const AUTHORIZATION_TYPES = {
  ExecutionAuthorization: [
    { name: 'intentId', type: 'string' },
    { name: 'ciphertextHash', type: 'bytes32' },
    { name: 'quoteHash', type: 'bytes32' },
    { name: 'callHash', type: 'bytes32' },
    { name: 'minimumBuyAmount', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
    { name: 'submissionMode', type: 'string' },
  ],
} as const;

export interface IntentMessage {
  protocolVersion: number;
  intentId: string;
  encryptionKeyId: Hex;
  ciphertextHash: Hex;
  nonce: string;
  expiresAt: bigint;
  executionDomain: bigint;
}

export interface AuthorizationMessage {
  intentId: string;
  ciphertextHash: Hex;
  quoteHash: Hex;
  callHash: Hex;
  minimumBuyAmount: bigint;
  deadline: bigint;
  /** Bound so an agent that authorized a private submission cannot have it
   * quietly broadcast through a public RPC instead. */
  submissionMode: string;
}

function as0x(hex: string): Hex {
  return (hex.startsWith('0x') ? hex : `0x${hex}`) as Hex;
}

export function intentMessage(env: IntentEnvelope): IntentMessage {
  return {
    protocolVersion: env.protocolVersion,
    intentId: env.intentId,
    encryptionKeyId: as0x(env.encryptionKeyId),
    ciphertextHash: as0x(env.ciphertextHash),
    nonce: env.nonce,
    expiresAt: BigInt(env.expiresAt),
    executionDomain: BigInt(env.executionDomain),
  };
}

/** The digest an agent signs for the envelope. Exposed so a wallet-less agent
 * can sign the hash directly and so tests can assert digest stability. */
export function intentDigest(env: IntentEnvelope): Hex {
  return hashTypedData({
    domain: intentDomain(env.executionDomain),
    types: INTENT_TYPES,
    primaryType: 'Intent',
    message: intentMessage(env),
  });
}

export function authorizationDigest(chainId: number, msg: AuthorizationMessage): Hex {
  return hashTypedData({
    domain: intentDomain(chainId),
    types: AUTHORIZATION_TYPES,
    primaryType: 'ExecutionAuthorization',
    message: msg,
  });
}

/**
 * Signs an envelope. Anything that can produce an EIP-712 signature fits — a
 * viem local account, a browser wallet, a remote signer — because Peal only
 * ever sees the result.
 */
export interface TypedDataSigner {
  signTypedData(args: {
    domain: TypedDataDomain;
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
}

export async function signIntent(env: IntentEnvelope, signer: TypedDataSigner): Promise<Hex> {
  return signer.signTypedData({
    domain: intentDomain(env.executionDomain),
    types: INTENT_TYPES as unknown as Record<string, readonly { name: string; type: string }[]>,
    primaryType: 'Intent',
    message: intentMessage(env) as unknown as Record<string, unknown>,
  });
}

export async function signAuthorization(
  chainId: number,
  msg: AuthorizationMessage,
  signer: TypedDataSigner,
): Promise<Hex> {
  return signer.signTypedData({
    domain: intentDomain(chainId),
    types: AUTHORIZATION_TYPES as unknown as Record<string, readonly { name: string; type: string }[]>,
    primaryType: 'ExecutionAuthorization',
    message: msg as unknown as Record<string, unknown>,
  });
}

/**
 * Verifies an envelope signature against the address the envelope claims.
 *
 * Returns false rather than throwing on a malformed signature: this runs on
 * every submitted intent, and a bad signature is an ordinary rejection, not an
 * exceptional condition.
 */
export async function verifyIntentSignature(env: IntentEnvelope): Promise<boolean> {
  if (!env.signature) return false;
  try {
    return await verifyTypedData({
      address: env.pseudonymousSigner as Address,
      domain: intentDomain(env.executionDomain),
      types: INTENT_TYPES,
      primaryType: 'Intent',
      message: intentMessage(env),
      signature: env.signature,
    });
  } catch {
    return false;
  }
}

export async function verifyAuthorizationSignature(
  chainId: number,
  msg: AuthorizationMessage,
  signature: Hex,
  expected: Address,
): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: expected,
      domain: intentDomain(chainId),
      types: AUTHORIZATION_TYPES,
      primaryType: 'ExecutionAuthorization',
      message: msg,
      signature,
    });
  } catch {
    return false;
  }
}

/** Who signed this envelope, regardless of who it claims. Used for logging a
 * mismatch, never as a substitute for `verifyIntentSignature` — recovering an
 * address always "succeeds" for any well-formed signature, so recovery alone
 * authenticates nothing. */
export async function recoverIntentSigner(env: IntentEnvelope): Promise<Address | null> {
  if (!env.signature) return null;
  try {
    return await recoverTypedDataAddress({
      domain: intentDomain(env.executionDomain),
      types: INTENT_TYPES,
      primaryType: 'Intent',
      message: intentMessage(env),
      signature: env.signature,
    });
  } catch {
    return null;
  }
}
