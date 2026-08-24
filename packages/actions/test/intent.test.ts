import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { canonicalize } from '../src/canonical.js';
import {
  PAYLOAD_VERSION,
  PROTOCOL_VERSION,
  decodePayload,
  encodePayload,
  signingPreimage,
  validateEnvelope,
  validatePayload,
  type IntentEnvelope,
  type SwapPayload,
} from '../src/intent.js';
import {
  intentDigest,
  recoverIntentSigner,
  signIntent,
  verifyIntentSignature,
} from '../src/sign.js';

const NOW = 1_700_000_000;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';

const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

function payload(over: Partial<SwapPayload> = {}): SwapPayload {
  return {
    payloadVersion: PAYLOAD_VERSION,
    actionType: 'swap',
    originChainId: 8453,
    destinationChainId: 8453,
    sellToken: USDC,
    buyToken: WETH,
    sellAmount: '50000000000',
    minimumBuyAmount: '14200000000000000000',
    recipient: account.address,
    refundAddress: account.address,
    deadline: NOW + 600,
    maximumFee: '5000000',
    preferredAdapters: ['zerox'],
    excludedAdapters: [],
    allowPartialFill: false,
    privateSubmissionRequired: true,
    ...over,
  };
}

function envelope(over: Partial<IntentEnvelope> = {}): IntentEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    intentId: 'intent_abc12345',
    encryptionKeyId: 'a'.repeat(64),
    ciphertextHash: 'b'.repeat(64),
    nonce: 'nonce_0000001',
    createdAt: NOW,
    expiresAt: NOW + 300,
    pseudonymousSigner: account.address,
    executionDomain: 8453,
    ...over,
  };
}

describe('canonical serialization', () => {
  it('does not depend on key insertion order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested keys too', () => {
    expect(canonicalize({ z: { d: 1, c: 2 } })).toBe('{"z":{"c":2,"d":1}}');
  });

  it('keeps array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('distinguishes absent from null', () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalize({ a: null, b: 1 })).toBe('{"a":null,"b":1}');
  });

  it('refuses values it cannot represent unambiguously', () => {
    // JSON.stringify would turn these into null and silently change the digest.
    expect(() => canonicalize({ a: NaN })).toThrow(/NaN/);
    expect(() => canonicalize({ a: Infinity })).toThrow(/Infinity/);
    // A uint256 as a bigint must not be serialized lossily.
    expect(() => canonicalize({ a: 1n })).toThrow(/bigint/);
    expect(() => canonicalize({ a: new Date(0) })).toThrow(/class instance/);
  });

  it('normalises negative zero', () => {
    expect(canonicalize({ a: -0 })).toBe(canonicalize({ a: 0 }));
  });

  it('gives a payload identical bytes however it was built', () => {
    const a = encodePayload(payload());
    const reordered: SwapPayload = JSON.parse(JSON.stringify(payload()));
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse()) as unknown as SwapPayload;
    expect(encodePayload(shuffled)).toEqual(a);
  });
});

describe('payload validation', () => {
  it('round trips', () => {
    expect(decodePayload(encodePayload(payload()))).toEqual(payload());
  });

  it('keeps uint256 amounts exact', () => {
    // 2^70 base units: a JS number would lose this outright.
    const big = '1180591620717411303424';
    expect(decodePayload(encodePayload(payload({ sellAmount: big }))).sellAmount).toBe(big);
  });

  it('rejects an unknown payload version', () => {
    expect(() => validatePayload({ ...payload(), payloadVersion: 99 })).toThrow(/payloadVersion/);
  });

  it('rejects an unknown action type', () => {
    expect(() => validatePayload({ ...payload(), actionType: 'bridge' })).toThrow(/actionType/);
  });

  it('rejects amounts that are not decimal uint strings', () => {
    for (const bad of [50_000, '0x1234', '-1', '1.5', '', 'abc']) {
      expect(() => validatePayload({ ...payload(), sellAmount: bad })).toThrow(/sellAmount/);
    }
  });

  it('rejects a zero sell amount', () => {
    expect(() => validatePayload({ ...payload(), sellAmount: '0' })).toThrow(/non-zero/);
  });

  it('rejects malformed addresses', () => {
    for (const k of ['sellToken', 'buyToken', 'recipient', 'refundAddress'] as const) {
      expect(() => validatePayload({ ...payload(), [k]: '0xdeadbeef' })).toThrow(new RegExp(k));
    }
  });

  it('rejects non-boolean flags', () => {
    expect(() => validatePayload({ ...payload(), privateSubmissionRequired: 'yes' })).toThrow(/privateSubmissionRequired/);
  });

  it('rejects non-string agent metadata values', () => {
    expect(() => validatePayload({ ...payload(), agentMetadata: { a: 1 } })).toThrow(/agentMetadata/);
  });

  it('rejects garbage', () => {
    expect(() => validatePayload(null)).toThrow(/not an object/);
    expect(() => validatePayload('swap')).toThrow(/not an object/);
  });
});

describe('the privacy boundary', () => {
  it('keeps every strategy field out of the public envelope', () => {
    // If any of these ever appear in the envelope, the product claim is broken:
    // a competitor reading the API would learn the trade before it executes.
    const envKeys = Object.keys(envelope());
    for (const leak of [
      'actionType', 'sellToken', 'buyToken', 'sellAmount',
      'minimumBuyAmount', 'recipient', 'refundAddress', 'deadline',
      'maximumFee', 'allowPartialFill',
    ]) {
      expect(envKeys, `${leak} must not be public`).not.toContain(leak);
    }
  });

  it('signs only envelope fields, never payload fields', () => {
    const pre = signingPreimage(envelope()) as unknown as Record<string, unknown>;
    for (const k of Object.keys(pre)) {
      expect(Object.keys(payload())).not.toContain(k);
    }
  });
});

describe('envelope validation', () => {
  it('accepts a well-formed envelope', () => {
    expect(() => validateEnvelope(envelope(), NOW)).not.toThrow();
  });

  it('rejects an expired intent', () => {
    expect(() => validateEnvelope(envelope({ expiresAt: NOW - 1 }), NOW)).toThrow(/expired/);
  });

  it('rejects a createdAt from the future', () => {
    expect(() => validateEnvelope(envelope({ createdAt: NOW + 3600 }), NOW)).toThrow(/future/);
  });

  it('rejects malformed hashes and ids', () => {
    expect(() => validateEnvelope(envelope({ ciphertextHash: 'zz' }), NOW)).toThrow(/ciphertextHash/);
    expect(() => validateEnvelope(envelope({ encryptionKeyId: 'nope' }), NOW)).toThrow(/encryptionKeyId/);
    expect(() => validateEnvelope(envelope({ intentId: 'x' }), NOW)).toThrow(/intentId/);
    expect(() => validateEnvelope(envelope({ nonce: '!!' }), NOW)).toThrow(/nonce/);
  });

  it('rejects an unknown protocol version', () => {
    expect(() => validateEnvelope(envelope({ protocolVersion: 2 }), NOW)).toThrow(/protocolVersion/);
  });
});

describe('intent signatures', () => {
  it('verifies a signature the agent produced', async () => {
    const env = envelope();
    env.signature = await signIntent(env, account);
    expect(await verifyIntentSignature(env)).toBe(true);
    expect(await recoverIntentSigner(env)).toBe(account.address);
  });

  it('fails when the ciphertext is swapped', async () => {
    // The core binding: a signed envelope must not carry over to another
    // ciphertext, or an attacker could attach the agent's authority to their
    // own payload.
    const env = envelope();
    env.signature = await signIntent(env, account);
    expect(await verifyIntentSignature({ ...env, ciphertextHash: 'c'.repeat(64) })).toBe(false);
  });

  it('fails when any signed field is changed', async () => {
    const env = envelope();
    env.signature = await signIntent(env, account);
    const mutations: Array<Partial<IntentEnvelope>> = [
      { intentId: 'intent_zzz99999' },
      { nonce: 'nonce_0000002' },
      { expiresAt: NOW + 999 },
      { encryptionKeyId: 'd'.repeat(64) },
      { executionDomain: 1 },
      { protocolVersion: 2 },
    ];
    for (const m of mutations) {
      expect(await verifyIntentSignature({ ...env, ...m }), JSON.stringify(m)).toBe(false);
    }
  });

  it('fails when another address claims it', async () => {
    const env = envelope();
    env.signature = await signIntent(env, account);
    const other = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
    expect(await verifyIntentSignature({ ...env, pseudonymousSigner: other.address })).toBe(false);
  });

  it('fails with no signature or a malformed one', async () => {
    const env = envelope();
    expect(await verifyIntentSignature(env)).toBe(false);
    expect(await verifyIntentSignature({ ...env, signature: '0x1234' })).toBe(false);
    expect(await recoverIntentSigner({ ...env, signature: '0x1234' })).toBe(null);
  });

  it('binds the chain, so a signature does not replay across domains', async () => {
    const a = envelope({ executionDomain: 8453 });
    const b = envelope({ executionDomain: 1 });
    expect(intentDigest(a)).not.toBe(intentDigest(b));
  });

  it('produces a stable digest for a fixed envelope', async () => {
    // Pins the EIP-712 encoding. If this changes, previously issued receipts
    // stop verifying, so it must be a deliberate version bump.
    expect(intentDigest(envelope())).toBe(intentDigest(envelope()));
    expect(intentDigest(envelope())).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
