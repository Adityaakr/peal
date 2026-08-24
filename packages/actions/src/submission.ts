/** How a validated transaction reaches the chain.
 *
 * This is a separate layer from the adapter on purpose. The adapter decides
 * *what* to execute; this decides *how it is broadcast*, and those two have
 * very different failure modes. Keeping them apart means an adapter cannot
 * quietly downgrade a private submission to a public one — it never holds the
 * ability to broadcast at all.
 *
 * The honesty rule this file exists to enforce:
 *
 *   Never advertise private execution unless the transaction was actually
 *   submitted through a private or solver-based path.
 *
 * A public RPC broadcast is a perfectly reasonable configuration. Calling it
 * private is not. So `submissionMode` is recorded on the receipt, it is bound
 * into the agent's authorization signature, and an intent that asked for
 * `privateSubmissionRequired` fails rather than silently degrading.
 */

import type { ExecutionProposal, ExecutionStatusReport } from './adapter.js';
import { AdapterError } from './adapter.js';
import type { SwapPayload } from './intent.js';

export type SubmissionMode = 'private' | 'solver' | 'public-rpc' | 'simulated';

export interface SubmissionResult {
  executionId: string;
  mode: SubmissionMode;
  originTransactionHash?: string;
  /** True only when the transaction never touched a public mempool. Written
   * onto the receipt; do not set it optimistically. */
  privateRoute: boolean;
}

export interface TransactionSubmissionProvider {
  readonly mode: SubmissionMode;
  /** Whether this provider actually serves the given chain. A provider that
   * says yes for a chain it cannot reach turns a privacy guarantee into a
   * dropped transaction. */
  supportsChain(chainId: number): boolean;
  submit(proposal: ExecutionProposal, signedTx: string): Promise<SubmissionResult>;
  waitForSettlement(executionId: string): Promise<ExecutionStatusReport>;
}

/** Sends to a private relay or protected endpoint that does not expose pending
 * transactions to a public mempool. */
export interface PrivateSubmissionProvider extends TransactionSubmissionProvider {
  readonly mode: 'private';
}

/** Hands the order to a solver network that settles it (CoW-shaped). Listed
 * for the interface; no implementation ships in V1. */
export interface SolverSubmissionProvider extends TransactionSubmissionProvider {
  readonly mode: 'solver';
}

/** Ordinary `eth_sendRawTransaction`. Everything in the public mempool sees it
 * before it is mined. */
export interface StandardRpcProvider extends TransactionSubmissionProvider {
  readonly mode: 'public-rpc';
}

export interface SubmissionPolicy {
  /** Ordered by preference. The first provider that serves the chain AND
   * satisfies the intent's privacy requirement wins. */
  providers: readonly TransactionSubmissionProvider[];
}

export class DegradedPrivacyError extends AdapterError {
  constructor(chainId: number) {
    super(
      'NO_PRIVATE_ROUTE',
      `intent requires private submission but no private or solver provider is configured for chain ${chainId}`,
    );
    this.name = 'DegradedPrivacyError';
  }
}

/** True when a mode keeps the transaction out of the public mempool. */
export function isPrivateMode(mode: SubmissionMode): boolean {
  return mode === 'private' || mode === 'solver';
}

/**
 * Pick the provider for this intent.
 *
 * Two outcomes, and the difference matters:
 *
 *  - `privateSubmissionRequired` and no private route: **throws**. The agent
 *    asked for a guarantee this deployment cannot give, and executing anyway
 *    while recording `public-rpc` would technically be honest on the receipt
 *    but would still have broadcast something the agent said not to.
 *  - No such requirement and only a public RPC: proceeds, returns
 *    `degraded: true`. The caller must surface the warning and the receipt
 *    records `public-rpc`. No sandwich protection may be claimed.
 */
export function selectProvider(
  payload: SwapPayload,
  policy: SubmissionPolicy,
): { provider: TransactionSubmissionProvider; degraded: boolean } {
  const chainId = payload.originChainId;
  const serving = policy.providers.filter((p) => p.supportsChain(chainId));

  const priv = serving.find((p) => isPrivateMode(p.mode));
  if (priv) return { provider: priv, degraded: false };

  if (payload.privateSubmissionRequired) throw new DegradedPrivacyError(chainId);

  const pub = serving.find((p) => p.mode === 'public-rpc');
  if (pub) return { provider: pub, degraded: true };

  const sim = serving.find((p) => p.mode === 'simulated');
  if (sim) return { provider: sim, degraded: true };

  throw new AdapterError('NO_SUBMISSION_ROUTE', `no submission provider configured for chain ${chainId}`);
}

/** The exact warning to show when execution is about to go out over a public
 * RPC. Kept here rather than in the UI so every surface says the same thing
 * and none of them soften it. */
export const DEGRADED_PRIVACY_WARNING =
  'This transaction will be broadcast through a public RPC. It will be visible in the ' +
  'public mempool before it is mined, and can be front-run or sandwiched during that ' +
  'window. Peal protected the ordering of this action, not its public broadcast.';

/**
 * Simulated submission, for tests and for the playground.
 *
 * It reports `mode: "simulated"` and `privateRoute: false`, and never claims a
 * transaction hash it did not get. A simulator that returned a plausible-looking
 * hash would put a fabricated value into a receipt, which is the one thing a
 * receipt must never contain.
 */
export class SimulatedSubmissionProvider implements TransactionSubmissionProvider {
  readonly mode = 'simulated' as const;
  private readonly results = new Map<string, ExecutionStatusReport>();
  private seq = 0;

  constructor(private readonly chainIds: readonly number[]) {}

  supportsChain(chainId: number): boolean {
    return this.chainIds.includes(chainId);
  }

  async submit(proposal: ExecutionProposal, _signedTx: string): Promise<SubmissionResult> {
    // Deterministic id, no clock and no randomness, so a simulated run is
    // reproducible and a test can assert on it.
    const executionId = `sim_${proposal.quoteId}_${this.seq++}`;
    this.results.set(executionId, {
      executionId,
      phase: 'DESTINATION_FILLED',
      settledSellAmount: proposal.sellAmount,
      // Settles at exactly the guaranteed minimum: the pessimistic case, so a
      // test that passes here passes for every real fill at or above it.
      settledBuyAmount: proposal.minBuyAmount,
    });
    return { executionId, mode: this.mode, privateRoute: false };
  }

  async waitForSettlement(executionId: string): Promise<ExecutionStatusReport> {
    const r = this.results.get(executionId);
    if (!r) throw new AdapterError('UNKNOWN_EXECUTION', `no simulated execution ${executionId}`);
    return r;
  }
}
