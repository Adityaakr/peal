/** The receipt: what an agent can check without trusting Peal.
 *
 * A receipt is only worth anything if the party it protects against did not
 * produce the evidence. So the design rule here is: every field either commits
 * a party to something they signed, or can be recomputed locally from data the
 * agent already has. Anything Peal merely asserts is labelled as such and
 * carries no weight in verification.
 *
 * What `verifyReceipt` actually establishes, in the order it checks:
 *
 *  1. the agent signed THIS ciphertext          (agent EIP-712 signature)
 *  2. the executor committed to a batch         (executor commitment signature)
 *  3. this ciphertext was in it, at this index  (inclusion proof vs orderingRoot)
 *  4. the commitment predates the reveal        (timestamps)
 *  5. enough distinct operators contributed     (threshold evidence)
 *  6. the executed quote met the signed floor   (quote binding)
 *  7. the agent authorized THIS transaction     (authorization signature)
 *  8. Peal has not edited the receipt since     (receipt signature)
 *
 * Step 4 is the one people skip. Without it an executor could commit to an
 * ordering AFTER seeing plaintext and the other seven checks would still pass.
 *
 * The payload itself is deliberately absent — only `revealedPayloadHash`. A
 * receipt is often shown to a third party to prove execution was fair, and it
 * should not be the thing that leaks the strategy afterwards.
 */

import { canonicalize } from './canonical.js';
import { digestsEqual, sha256Hex } from './hash.js';
import { verifyInclusion, type InclusionProof } from './commitment.js';
import { verifyIntentSignature, verifyAuthorizationSignature, type AuthorizationMessage } from './sign.js';
import type { Hex, IntentEnvelope } from './intent.js';

export const RECEIPT_VERSION = 1;

export type SubmissionMode = 'private' | 'solver' | 'public-rpc' | 'simulated';
export type ExecutionStatus = 'SETTLED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';

export interface ExecutionReceipt {
  receiptVersion: number;
  protocolVersion: number;

  intentId: string;
  agentIdentity: Hex;
  agentSignature: Hex;
  ciphertextHash: string;
  encryptionKeyId: string;
  /** Envelope fields the agent signature covers, needed to recheck it. */
  nonce: string;
  expiresAt: number;
  executionDomain: number;

  batchId: string;
  batchPosition: number;
  batchSize: number;
  orderingRoot: string;
  inclusionProof: InclusionProof;
  executorIdentity: string;
  executorCommitmentSignature: string;
  commitmentTimestamp: number;

  revealTimestamp: number;
  threshold: number;
  committeeSize: number;
  /** Which operators contributed a verified share. Identities, never shares. */
  operatorIdentities: number[];
  /** Per-operator evidence: the hash of each accepted share, so an auditor can
   * re-verify against the coordinator's public share log. */
  shareCommitments: string[];

  /** sha256 of the canonical revealed payload. Not the payload. */
  revealedPayloadHash: string;

  adapterId: string;
  adapterVersion: string;
  quoteHash: string;
  executionAuthorizationHash: string;
  authorizationSignature?: Hex;
  submissionMode: SubmissionMode;

  originTransactionHash?: string;
  destinationTransactionHash?: string;
  executionStatus: ExecutionStatus;
  settledSellAmount?: string;
  settledBuyAmount?: string;
  /** The floor the agent signed, echoed so verification needs only the receipt. */
  minimumBuyAmount: string;
  fees?: Record<string, string>;
  errorCode?: string;

  receiptTimestamp: number;
  receiptSignature?: string;
}

/** Everything except the receipt signature, canonicalized. */
export function receiptPreimage(r: ExecutionReceipt): string {
  const { receiptSignature: _drop, ...rest } = r;
  return canonicalize(rest);
}

export async function receiptHash(r: ExecutionReceipt): Promise<string> {
  return sha256Hex(new TextEncoder().encode(receiptPreimage(r)));
}

export interface VerifyOptions {
  /** Recomputes the executor commitment digest. Supplied by the caller because
   * how an executor identity is checked (address, key, allowlist) is
   * deployment policy, not receipt format. */
  verifyExecutorCommitment?: (r: ExecutionReceipt) => Promise<boolean>;
  /** Same for the coordinator's own signature over the finished receipt. */
  verifyReceiptSignature?: (r: ExecutionReceipt) => Promise<boolean>;
  /** Executors the agent is willing to be ordered by. Omit to skip. */
  trustedExecutors?: readonly string[];
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerificationReport {
  ok: boolean;
  checks: CheckResult[];
}

function check(name: string, ok: boolean, detail?: string): CheckResult {
  return detail === undefined ? { name, ok } : { name, ok, detail };
}

/**
 * Verify a receipt.
 *
 * Returns a report rather than a boolean: an agent that gets `false` needs to
 * know WHICH guarantee broke, because "the quote was under my floor" and "the
 * executor is not one I trust" call for very different responses.
 *
 * Checks are independent by design — one failure does not short-circuit the
 * rest, so a single call surfaces every problem at once.
 */
export async function verifyReceipt(
  r: ExecutionReceipt,
  opts: VerifyOptions = {},
): Promise<VerificationReport> {
  const checks: CheckResult[] = [];

  // Details that merely restate a rule are attached only when the rule is
  // broken; on a passing check they read as a warning about nothing.
  const versionOk = r.receiptVersion === RECEIPT_VERSION;
  checks.push(check('receiptVersion', versionOk, versionOk ? undefined : `expected ${RECEIPT_VERSION}`));

  // 1. The agent signed this exact ciphertext, on this chain, with this nonce.
  const envelope: IntentEnvelope = {
    protocolVersion: r.protocolVersion,
    intentId: r.intentId,
    encryptionKeyId: r.encryptionKeyId,
    ciphertextHash: r.ciphertextHash,
    nonce: r.nonce,
    createdAt: 0,
    expiresAt: r.expiresAt,
    pseudonymousSigner: r.agentIdentity,
    executionDomain: r.executionDomain,
    signature: r.agentSignature,
  };
  checks.push(check('agentSignature', await verifyIntentSignature(envelope)));

  // 2 + 3. The executor committed to a batch, and this intent was in it here.
  checks.push(
    check(
      'batchInclusion',
      await verifyInclusion(r.intentId, r.ciphertextHash, r.inclusionProof, r.orderingRoot),
    ),
  );
  const positionOk =
    r.inclusionProof.position === r.batchPosition && r.inclusionProof.batchSize === r.batchSize;
  checks.push(
    check(
      'batchPosition',
      positionOk,
      positionOk ? undefined : `proof claims position ${r.inclusionProof.position} of ${r.inclusionProof.batchSize}, receipt claims ${r.batchPosition} of ${r.batchSize}`,
    ),
  );

  if (opts.verifyExecutorCommitment) {
    checks.push(check('executorCommitmentSignature', await opts.verifyExecutorCommitment(r)));
  } else {
    checks.push(check('executorCommitmentSignature', false, 'no verifier supplied; commitment unchecked'));
  }

  if (opts.trustedExecutors) {
    const trusted = opts.trustedExecutors.map((e) => e.toLowerCase());
    checks.push(check('executorTrusted', trusted.includes(r.executorIdentity.toLowerCase())));
  }

  // 4. Ordering was locked before anything could be read. Without this the
  //    commitment proves nothing: an executor could commit after the fact.
  checks.push(
    check(
      'commitmentPrecedesReveal',
      r.commitmentTimestamp > 0 && r.revealTimestamp > 0 && r.commitmentTimestamp < r.revealTimestamp,
      `committed ${r.commitmentTimestamp}, revealed ${r.revealTimestamp}`,
    ),
  );

  // 5. Enough distinct operators. Duplicates from one operator are the obvious
  //    way to fake a threshold, so distinctness is checked, not assumed.
  const distinct = new Set(r.operatorIdentities);
  checks.push(
    check(
      'thresholdEvidence',
      r.threshold > 0 &&
        r.threshold <= r.committeeSize &&
        distinct.size === r.operatorIdentities.length &&
        distinct.size >= r.threshold &&
        r.shareCommitments.length === r.operatorIdentities.length,
      `${distinct.size} distinct of ${r.operatorIdentities.length} claimed, need ${r.threshold}`,
    ),
  );

  // 6. The executed amount honoured the floor the agent signed. Only meaningful
  //    on a settled receipt; a failed one has nothing to compare.
  if (r.executionStatus === 'SETTLED') {
    let ok = false;
    let detail = 'settledBuyAmount missing';
    if (r.settledBuyAmount !== undefined) {
      try {
        ok = BigInt(r.settledBuyAmount) >= BigInt(r.minimumBuyAmount);
        detail = `got ${r.settledBuyAmount}, floor ${r.minimumBuyAmount}`;
      } catch {
        detail = 'amounts are not decimal integers';
      }
    }
    checks.push(check('quoteHonouredFloor', ok, detail));
  }

  // 7. The agent authorized this specific transaction, not merely the intent.
  //    A simulated run has no authorization to check and says so.
  if (r.submissionMode === 'simulated') {
    checks.push(check('executionAuthorization', true, 'simulated: no on-chain authorization'));
  } else {
    const authOk =
      Boolean(r.authorizationSignature) && /^[0-9a-f]{64}$/.test(r.executionAuthorizationHash);
    checks.push(
      check(
        'executionAuthorization',
        authOk,
        authOk ? undefined : 'a non-simulated execution must carry an agent authorization',
      ),
    );
  }

  // 8. Nothing edited after the fact.
  if (opts.verifyReceiptSignature) {
    checks.push(check('receiptSignature', await opts.verifyReceiptSignature(r)));
  } else {
    checks.push(check('receiptSignature', false, 'no verifier supplied; receipt integrity unchecked'));
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/** Re-check that a receipt describes the payload an agent actually sealed.
 *
 * Separate from `verifyReceipt` because only the agent can run it: it needs the
 * plaintext, which the receipt deliberately does not carry. */
export async function receiptMatchesPayload(
  r: ExecutionReceipt,
  payloadBytes: Uint8Array,
): Promise<boolean> {
  return digestsEqual(await sha256Hex(payloadBytes), r.revealedPayloadHash);
}

/** Bind an authorization message to its receipt field. */
export async function authorizationHash(msg: AuthorizationMessage): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(
      canonicalize({
        intentId: msg.intentId,
        ciphertextHash: msg.ciphertextHash,
        quoteHash: msg.quoteHash,
        callHash: msg.callHash,
        minimumBuyAmount: msg.minimumBuyAmount.toString(),
        deadline: Number(msg.deadline),
        submissionMode: msg.submissionMode,
      }),
    ),
  );
}

export { verifyAuthorizationSignature };
