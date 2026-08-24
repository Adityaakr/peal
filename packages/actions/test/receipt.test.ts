import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { buildInclusionProof, computeOrderingRoot, type CommittedSlot } from '../src/commitment.js';
import { sha256Hex } from '../src/hash.js';
import { PAYLOAD_VERSION, PROTOCOL_VERSION, encodePayload, type IntentEnvelope, type SwapPayload } from '../src/intent.js';
import { signIntent } from '../src/sign.js';
import {
  RECEIPT_VERSION,
  receiptHash,
  receiptMatchesPayload,
  receiptPreimage,
  verifyReceipt,
  type ExecutionReceipt,
} from '../src/receipt.js';

const NOW = 1_700_000_000;
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const EXECUTOR = '0xExEc000000000000000000000000000000000001';

const swap: SwapPayload = {
  payloadVersion: PAYLOAD_VERSION,
  actionType: 'swap',
  originChainId: 8453,
  destinationChainId: 8453,
  sellToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  buyToken: '0x4200000000000000000000000000000000000006',
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
};

/** Builds a receipt the same way the executor would: real signature, real
 * merkle root, real inclusion proof. Only the executor and coordinator
 * signatures are stubbed, since those are deployment policy. */
async function buildReceipt(over: Partial<ExecutionReceipt> = {}): Promise<ExecutionReceipt> {
  const payloadBytes = encodePayload(swap);
  const ciphertextHash = await sha256Hex(new TextEncoder().encode('pretend-ciphertext'));
  const intentId = 'intent_abc12345';

  const batch: CommittedSlot[] = Array.from({ length: 8 }, (_, i) => ({
    position: i,
    intentId: i === 3 ? intentId : `other_${i}`,
    ciphertextHash: i === 3 ? ciphertextHash : i.toString(16).padStart(2, '0').repeat(32),
    isDummy: i >= 6,
  }));
  const orderingRoot = await computeOrderingRoot(batch);
  const inclusionProof = await buildInclusionProof(batch, 3);

  const env: IntentEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    intentId,
    encryptionKeyId: 'a'.repeat(64),
    ciphertextHash,
    nonce: 'nonce_0000001',
    createdAt: NOW,
    expiresAt: NOW + 300,
    pseudonymousSigner: account.address,
    executionDomain: 8453,
  };
  const agentSignature = await signIntent(env, account);

  return {
    receiptVersion: RECEIPT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    intentId,
    agentIdentity: account.address,
    agentSignature,
    ciphertextHash,
    encryptionKeyId: env.encryptionKeyId,
    nonce: env.nonce,
    expiresAt: env.expiresAt,
    executionDomain: env.executionDomain,
    batchId: 'batch_1',
    batchPosition: 3,
    batchSize: 8,
    orderingRoot,
    inclusionProof,
    executorIdentity: EXECUTOR,
    executorCommitmentSignature: '0x' + 'ee'.repeat(65),
    commitmentTimestamp: NOW + 10,
    revealTimestamp: NOW + 40,
    threshold: 3,
    committeeSize: 5,
    operatorIdentities: [1, 2, 4],
    shareCommitments: ['1'.repeat(64), '2'.repeat(64), '4'.repeat(64)],
    revealedPayloadHash: await sha256Hex(payloadBytes),
    adapterId: 'zerox-swap-v2',
    adapterVersion: '1',
    quoteHash: '9'.repeat(64),
    executionAuthorizationHash: '7'.repeat(64),
    authorizationSignature: ('0x' + 'aa'.repeat(65)) as `0x${string}`,
    submissionMode: 'private',
    originTransactionHash: '0x' + 'cd'.repeat(32),
    executionStatus: 'SETTLED',
    settledSellAmount: '50000000000',
    settledBuyAmount: '14350000000000000000',
    minimumBuyAmount: swap.minimumBuyAmount,
    receiptTimestamp: NOW + 60,
    ...over,
  };
}

const PASS = {
  verifyExecutorCommitment: async () => true,
  verifyReceiptSignature: async () => true,
};

async function failing(r: ExecutionReceipt, name: string) {
  const rep = await verifyReceipt(r, PASS);
  const c = rep.checks.find((x) => x.name === name);
  expect(c, `check ${name} not found`).toBeDefined();
  return { report: rep, check: c! };
}

describe('a good receipt', () => {
  it('passes every check', async () => {
    const rep = await verifyReceipt(await buildReceipt(), PASS);
    expect(rep.checks.filter((c) => !c.ok)).toEqual([]);
    expect(rep.ok).toBe(true);
  });

  it('matches the payload the agent sealed', async () => {
    expect(await receiptMatchesPayload(await buildReceipt(), encodePayload(swap))).toBe(true);
  });

  it('carries no strategy field that settlement had not already made public', async () => {
    // A receipt gets shown to third parties to prove fair execution, so it must
    // not become the thing that leaks the strategy afterwards.
    //
    // The line is drawn at "already public": once the swap settles, its amounts
    // and its minimum-out sit in the transaction's own calldata, so echoing
    // them costs nothing and the floor check needs them. Everything the agent
    // sealed that settlement does NOT publish stays out — the fee ceiling it
    // was willing to pay, which adapters it prefers or refuses, whether it
    // would accept a partial fill, and any agent metadata. Those describe how
    // the agent trades, not what this one trade did.
    // Checked structurally, on field names. Searching the serialized text for
    // raw values gives false positives — maximumFee "5000000" is a substring of
    // settledSellAmount "50000000000" — which would make this test noise.
    const r = await buildReceipt();
    const keys = Object.keys(r);
    for (const secret of [
      'actionType', 'sellToken', 'buyToken', 'recipient', 'refundAddress',
      'deadline', 'maximumFee', 'preferredAdapters', 'excludedAdapters',
      'allowPartialFill', 'privateSubmissionRequired', 'agentMetadata',
    ]) {
      expect(keys, `${secret} must not be in the receipt`).not.toContain(secret);
    }
    // And the payload never appears wholesale in any nested field.
    expect(receiptPreimage(r)).not.toContain(new TextDecoder().decode(encodePayload(swap)));
  });

  it('hashes deterministically regardless of key order', async () => {
    const r = await buildReceipt();
    const shuffled = Object.fromEntries(Object.entries(r).reverse()) as unknown as ExecutionReceipt;
    expect(await receiptHash(shuffled)).toBe(await receiptHash(r));
  });
});

describe('a tampered receipt', () => {
  it('fails when the payload hash is changed', async () => {
    const r = await buildReceipt({ revealedPayloadHash: 'f'.repeat(64) });
    expect(await receiptMatchesPayload(r, encodePayload(swap))).toBe(false);
  });

  it('fails when the ciphertext hash is swapped', async () => {
    const { report } = await failing(await buildReceipt({ ciphertextHash: 'f'.repeat(64) }), 'agentSignature');
    expect(report.ok).toBe(false);
    // Both the signature and the inclusion proof should notice.
    expect(report.checks.find((c) => c.name === 'agentSignature')!.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'batchInclusion')!.ok).toBe(false);
  });

  it('fails when the claimed position does not match the proof', async () => {
    const { check } = await failing(await buildReceipt({ batchPosition: 5 }), 'batchPosition');
    expect(check.ok).toBe(false);
  });

  it('fails when the ordering root is changed', async () => {
    const { check } = await failing(await buildReceipt({ orderingRoot: 'a'.repeat(64) }), 'batchInclusion');
    expect(check.ok).toBe(false);
  });

  it('fails when the commitment did not precede the reveal', async () => {
    // The check people forget. Without it an executor commits AFTER reading
    // plaintext and every other check still passes.
    const { check } = await failing(
      await buildReceipt({ commitmentTimestamp: NOW + 50, revealTimestamp: NOW + 40 }),
      'commitmentPrecedesReveal',
    );
    expect(check.ok).toBe(false);
  });

  it('fails when the same operator is counted twice to fake a threshold', async () => {
    const { check } = await failing(
      await buildReceipt({ operatorIdentities: [2, 2, 2], shareCommitments: ['a'.repeat(64), 'a'.repeat(64), 'a'.repeat(64)] }),
      'thresholdEvidence',
    );
    expect(check.ok).toBe(false);
  });

  it('fails when fewer operators than the threshold contributed', async () => {
    const { check } = await failing(
      await buildReceipt({ operatorIdentities: [1, 2], shareCommitments: ['a'.repeat(64), 'b'.repeat(64)] }),
      'thresholdEvidence',
    );
    expect(check.ok).toBe(false);
  });

  it('fails when share evidence does not cover every claimed operator', async () => {
    const { check } = await failing(
      await buildReceipt({ operatorIdentities: [1, 2, 3], shareCommitments: ['a'.repeat(64)] }),
      'thresholdEvidence',
    );
    expect(check.ok).toBe(false);
  });

  it('fails when settlement came in under the signed floor', async () => {
    const { check } = await failing(
      await buildReceipt({ settledBuyAmount: '14100000000000000000' }),
      'quoteHonouredFloor',
    );
    expect(check.ok).toBe(false);
  });

  it('accepts settlement exactly at the floor', async () => {
    const { check } = await failing(
      await buildReceipt({ settledBuyAmount: swap.minimumBuyAmount }),
      'quoteHonouredFloor',
    );
    expect(check.ok).toBe(true);
  });

  it('fails when a live execution carries no agent authorization', async () => {
    const r = await buildReceipt();
    delete (r as Partial<ExecutionReceipt>).authorizationSignature;
    const { check } = await failing(r, 'executionAuthorization');
    expect(check.ok).toBe(false);
  });

  it('fails when the executor is not one the agent trusts', async () => {
    const rep = await verifyReceipt(await buildReceipt(), {
      ...PASS,
      trustedExecutors: ['0x0000000000000000000000000000000000000009'],
    });
    expect(rep.checks.find((c) => c.name === 'executorTrusted')!.ok).toBe(false);
    expect(rep.ok).toBe(false);
  });

  it('fails on an unknown receipt version', async () => {
    const { check } = await failing(await buildReceipt({ receiptVersion: 99 }), 'receiptVersion');
    expect(check.ok).toBe(false);
  });
});

describe('honest defaults', () => {
  it('does not silently pass unverifiable signatures', async () => {
    // With no verifier supplied, the commitment and receipt signatures are
    // UNCHECKED. Reporting those as ok would be the worst kind of green tick.
    const rep = await verifyReceipt(await buildReceipt());
    expect(rep.ok).toBe(false);
    for (const name of ['executorCommitmentSignature', 'receiptSignature']) {
      const c = rep.checks.find((x) => x.name === name)!;
      expect(c.ok).toBe(false);
      expect(c.detail).toMatch(/unchecked/);
    }
  });

  it('labels a simulated run instead of pretending it was authorized', async () => {
    const r = await buildReceipt({ submissionMode: 'simulated' });
    delete (r as Partial<ExecutionReceipt>).authorizationSignature;
    const { check } = await failing(r, 'executionAuthorization');
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/simulated/);
  });

  it('reports every failure at once rather than stopping at the first', async () => {
    const rep = await verifyReceipt(
      await buildReceipt({ receiptVersion: 99, batchPosition: 5, settledBuyAmount: '1' }),
      PASS,
    );
    expect(rep.checks.filter((c) => !c.ok).length).toBeGreaterThanOrEqual(3);
  });

  it('skips the floor check on a failed execution', async () => {
    // Nothing settled, so there is no amount to compare; asserting one would
    // manufacture a verdict.
    const rep = await verifyReceipt(
      await buildReceipt({ executionStatus: 'FAILED', settledBuyAmount: undefined, errorCode: 'NO_LIQUIDITY' }),
      PASS,
    );
    expect(rep.checks.find((c) => c.name === 'quoteHonouredFloor')).toBeUndefined();
  });
});
