/** The execution adapter boundary.
 *
 * Peal does not create liquidity, hold inventory, or route orders itself. It
 * hands a revealed intent to an adapter that talks to an external venue. That
 * separation is the point: Peal's job is confidentiality and ordering, and a
 * system that also made markets would have every incentive Peal exists to
 * remove.
 *
 * The single most important rule in this file is enforced by types, not by
 * discipline: `getExecutionProposal` cannot be called without an
 * `IntentLifecycle` that is already past ordering and reveal. There is no
 * overload that skips it. An adapter physically cannot leak an intent to a
 * liquidity provider early, because it is never handed one early.
 */

import type { IntentLifecycle } from './state.js';
import type { ActionPayload, Hex, IntentEnvelope } from './intent.js';

/** A revealed intent: the envelope that was always public, plus the payload
 * that has just become readable. Adapters only ever see this shape, and only
 * after the batch has opened. */
export interface RevealedIntent {
  envelope: IntentEnvelope;
  payload: ActionPayload;
}

/** An unsigned transaction an adapter wants executed. Nothing here is trusted
 * until `validateExecutionProposal` has passed. */
export interface ProposedCall {
  to: Hex;
  data: Hex;
  value: string;
  gas?: string;
  gasPrice?: string;
}

/** Approvals the adapter says are needed before the swap can run.
 *
 * Separated from the swap call so they can be validated under a stricter rule:
 * an approval hands away spending power, so its spender is checked against a
 * configured allowlist and never simply believed. */
export interface ProposedApproval {
  token: Hex;
  spender: Hex;
  amount: string;
  call: ProposedCall;
}

export interface ExecutionProposal {
  adapterId: string;
  adapterVersion: string;
  /** Opaque venue reference, for support and for `getStatus`. */
  quoteId: string;
  /** What the venue says the agent gets. */
  buyAmount: string;
  /** What the venue guarantees at the stated slippage. This is the number
   * compared against the agent's signed floor — never `buyAmount`, which is a
   * mid-market expectation the venue does not commit to. */
  minBuyAmount: string;
  sellAmount: string;
  buyToken: Hex;
  sellToken: Hex;
  chainId: number;
  approvals: ProposedApproval[];
  call: ProposedCall;
  /** Unix seconds after which this proposal must not be submitted. */
  expiresAt: number;
  /** Everything the venue returned, for the audit trail. Never used in a
   * decision without an explicit check above. */
  raw: unknown;
}

export interface ValidationIssue {
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/** What the agent signed, handed back for submission. An adapter cannot
 * manufacture one of these — only the agent's key can. */
export interface ExecutionAuthorization {
  intentId: string;
  quoteHash: string;
  callHash: string;
  signature: Hex;
  submissionMode: string;
}

export interface ExecutionHandle {
  executionId: string;
  originTransactionHash?: string;
}

export type SettlementPhase =
  | 'PENDING'
  | 'ORIGIN_CONFIRMED'
  | 'IN_FLIGHT'
  | 'DESTINATION_FILLED'
  | 'REFUNDED'
  | 'FAILED';

export interface ExecutionStatusReport {
  executionId: string;
  phase: SettlementPhase;
  originTransactionHash?: string;
  destinationTransactionHash?: string;
  settledSellAmount?: string;
  settledBuyAmount?: string;
  fees?: Record<string, string>;
  errorCode?: string;
}

export interface ReceiptData {
  adapterId: string;
  adapterVersion: string;
  quoteHash: string;
  originTransactionHash?: string;
  destinationTransactionHash?: string;
  settledSellAmount?: string;
  settledBuyAmount?: string;
  fees?: Record<string, string>;
  errorCode?: string;
}

export interface ExecutionAdapter {
  readonly id: string;
  readonly version: string;

  /** Whether this adapter handles this action at all. Cheap, no network. */
  supports(intent: RevealedIntent): boolean;

  /** Static checks that need no venue: sane amounts, deadline in the future,
   * chains this adapter serves. Throws with a stable code. */
  validateIntent(intent: RevealedIntent): void;

  /**
   * Ask the venue for a fresh, executable quote.
   *
   * The `lifecycle` argument is not decoration and not logging. It is the
   * gate: implementations must refuse unless `lifecycle.mayRequestQuote` is
   * true, which is only the case at REVEALED or QUOTING. Requiring it in the
   * signature means an adapter cannot be called early even by mistake.
   */
  getExecutionProposal(intent: RevealedIntent, lifecycle: IntentLifecycle): Promise<ExecutionProposal>;

  /** Re-check the venue's answer against what the agent actually signed.
   * Never trusts the proposal it is validating. */
  validateExecutionProposal(intent: RevealedIntent, proposal: ExecutionProposal): ValidationResult;

  execute(
    intent: RevealedIntent,
    proposal: ExecutionProposal,
    authorization: ExecutionAuthorization,
  ): Promise<ExecutionHandle>;

  getStatus(executionId: string): Promise<ExecutionStatusReport>;

  buildReceiptData(executionId: string): Promise<ReceiptData>;
}

export class AdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

/** Thrown when an adapter is asked for a quote before the batch has opened.
 * Its own type because it is a privacy failure, not an ordinary error, and
 * should be alertable separately. */
export class PrematureQuoteError extends AdapterError {
  constructor(state: string) {
    super(
      'PREMATURE_QUOTE',
      `refusing to contact a liquidity provider from state ${state}: ordering must be committed and the batch revealed first`,
    );
    this.name = 'PrematureQuoteError';
  }
}

/** Every adapter calls this first. One implementation, so the rule cannot
 * drift between adapters. */
export function assertMayQuote(lifecycle: IntentLifecycle): void {
  if (!lifecycle.mayRequestQuote) throw new PrematureQuoteError(lifecycle.state);
}
