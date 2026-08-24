/** 0x Swap API v2 adapter — same-chain EVM swaps.
 *
 * Endpoint shapes verified against docs.0x.org at implementation time, not
 * recalled: base `https://api.0x.org`, `GET /swap/allowance-holder/quote`,
 * headers `0x-api-key` and `0x-version: v2`. Swap API v1 is retired and is not
 * used anywhere here.
 *
 * The governing idea: **the quote is hostile input.** It arrives over the
 * network, after the agent has stopped looking, and it carries calldata that
 * will be executed with the agent's own funds. Every field that could move
 * value is re-derived or re-checked against what the agent actually signed, and
 * anything unrecognised is refused rather than passed through.
 *
 * Three rules that are easy to get wrong and expensive to get wrong:
 *
 *  1. `minBuyAmount` is the number that matters, not `buyAmount`. `buyAmount`
 *     is an expectation the venue does not commit to; `minBuyAmount` is what
 *     survives slippage. Comparing the agent's floor against `buyAmount` would
 *     pass quotes that settle underneath it.
 *
 *  2. Approvals go only to `allowanceTarget` as returned by the AllowanceHolder
 *     flow, AND only if that address is in operator-configured trusted config.
 *     Never approve the Settler contract. An approval is a standing grant of
 *     spending power, so "the API told us to" is not sufficient authority.
 *
 *  3. A quote is requested only after ordering is committed and the batch is
 *     revealed. Enforced by `assertMayQuote`, not by call-site discipline.
 */

import {
  AdapterError,
  assertMayQuote,
  type ExecutionAdapter,
  type ExecutionAuthorization,
  type ExecutionHandle,
  type ExecutionProposal,
  type ExecutionStatusReport,
  type ProposedApproval,
  type ReceiptData,
  type RevealedIntent,
  type ValidationIssue,
  type ValidationResult,
} from '../adapter.js';
import type { Hex, SwapPayload } from '../intent.js';
import type { IntentLifecycle } from '../state.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';

export const ZEROX_BASE_URL = 'https://api.0x.org';
const ADAPTER_ID = 'zerox-swap-v2';
const ADAPTER_VERSION = '1';

/** The v2 quote response, narrowed to the fields this adapter actually reads.
 * Anything not listed here is carried in `raw` for the audit trail and never
 * influences a decision. */
interface ZeroExQuote {
  liquidityAvailable: boolean;
  zid?: string;
  allowanceTarget?: string;
  buyAmount?: string | null;
  sellAmount?: string | null;
  minBuyAmount?: string | null;
  buyToken?: string;
  sellToken?: string;
  totalNetworkFee?: string | null;
  transaction?: {
    to?: string;
    data?: string;
    value?: string | null;
    gas?: string | null;
    gasPrice?: string | null;
  };
  issues?: {
    balance?: { token?: string; actual?: string | null; expected?: string | null } | null;
    allowance?: { actual?: string | null; spender?: string } | null;
    simulationIncomplete?: boolean;
    invalidSourcesPassed?: unknown[];
  } | null;
  fees?: {
    integratorFee?: string | null;
    zeroExFee?: string | null;
    gasFee?: string | null;
  } | null;
}

export interface ZeroExConfig {
  /** Server-side only. Never reaches the browser. */
  apiKey: string;
  baseUrl?: string;
  /** Chains this deployment will execute on. An intent for anything else is
   * refused rather than attempted. */
  supportedChainIds: readonly number[];
  /**
   * Addresses this deployment is willing to grant token approvals to, per
   * chain, lowercased.
   *
   * Deliberately operator-configured rather than hardcoded here. An allowlist
   * baked into library source is one supply-chain compromise away from
   * redirecting every approval, and it silently rots when a venue redeploys.
   * The operator states which contracts they trust; the adapter enforces it.
   */
  trustedAllowanceTargets: Readonly<Record<number, readonly string[]>>;
  /** How long a fetched quote is considered executable. 0x does not return an
   * explicit expiry, and a stale quote is a losing trade, so this is short. */
  quoteTtlSecs?: number;
  /** Bounded retries for transient failures, never past the intent deadline. */
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DEFAULT_TTL = 30;
const DEFAULT_ATTEMPTS = 3;

function isAddress(v: unknown): v is Hex {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}

function isUint(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]+$/.test(v);
}

function eq(a: string | undefined, b: string | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** Stable hash of the parts of a proposal that must not change between the
 * agent seeing it and it being submitted. Bound into the authorization, so a
 * swapped quote or one byte of altered calldata invalidates the signature. */
export async function quoteHash(p: ExecutionProposal): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(
      canonicalize({
        adapterId: p.adapterId,
        chainId: p.chainId,
        sellToken: p.sellToken.toLowerCase(),
        buyToken: p.buyToken.toLowerCase(),
        sellAmount: p.sellAmount,
        minBuyAmount: p.minBuyAmount,
        to: p.call.to.toLowerCase(),
        data: p.call.data,
        value: p.call.value,
        approvals: p.approvals.map((a) => ({
          token: a.token.toLowerCase(),
          spender: a.spender.toLowerCase(),
          amount: a.amount,
        })),
      }),
    ),
  );
}

export async function callHash(p: ExecutionProposal): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(
      canonicalize({ to: p.call.to.toLowerCase(), data: p.call.data, value: p.call.value }),
    ),
  );
}

export class ZeroExAdapter implements ExecutionAdapter {
  readonly id = ADAPTER_ID;
  readonly version = ADAPTER_VERSION;

  private readonly proposals = new Map<string, ExecutionProposal>();
  private readonly executions = new Map<string, ExecutionStatusReport>();

  constructor(private readonly cfg: ZeroExConfig) {
    if (!cfg.apiKey) throw new AdapterError('CONFIG', '0x API key is required and must be server-side only');
  }

  private get fetch(): typeof fetch {
    return this.cfg.fetchImpl ?? globalThis.fetch;
  }

  private now(): number {
    return this.cfg.now ? this.cfg.now() : Math.floor(Date.now() / 1000);
  }

  supports(intent: RevealedIntent): boolean {
    const p = intent.payload;
    return (
      p.actionType === 'swap' &&
      // Same-chain only. Cross-chain is the Across adapter's job, and silently
      // treating a bridge as a swap would strand funds on the wrong chain.
      p.originChainId === p.destinationChainId &&
      this.cfg.supportedChainIds.includes(p.originChainId)
    );
  }

  validateIntent(intent: RevealedIntent): void {
    const p = intent.payload as SwapPayload;
    if (!this.supports(intent)) throw new AdapterError('UNSUPPORTED', 'this adapter does not handle this intent');
    if (!this.cfg.trustedAllowanceTargets[p.originChainId]?.length) {
      throw new AdapterError('CONFIG', `no trusted allowance targets configured for chain ${p.originChainId}`);
    }
    if (p.deadline <= this.now()) throw new AdapterError('EXPIRED', 'intent deadline has already passed');
    if (BigInt(p.sellAmount) <= 0n) throw new AdapterError('BAD_AMOUNT', 'sellAmount must be positive');
    if (BigInt(p.minimumBuyAmount) <= 0n) {
      // A zero floor is a blank cheque to the venue. Refuse rather than execute
      // a swap the agent placed no bound on.
      throw new AdapterError('BAD_AMOUNT', 'minimumBuyAmount must be positive');
    }
    if (eq(p.sellToken, p.buyToken)) throw new AdapterError('BAD_PAIR', 'sellToken and buyToken are the same');
    if (p.excludedAdapters.includes(this.id)) throw new AdapterError('EXCLUDED', 'the agent excluded this adapter');
  }

  async getExecutionProposal(intent: RevealedIntent, lifecycle: IntentLifecycle): Promise<ExecutionProposal> {
    // The privacy gate. Nothing above this line touches the network.
    assertMayQuote(lifecycle);
    this.validateIntent(intent);

    const p = intent.payload as SwapPayload;
    const attempts = this.cfg.maxAttempts ?? DEFAULT_ATTEMPTS;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      // Re-checked every attempt: a retry loop that outlives the deadline would
      // submit a trade the agent no longer authorized.
      if (this.now() >= p.deadline) throw new AdapterError('EXPIRED', 'intent deadline passed while quoting');
      try {
        const quote = await this.fetchQuote(p);
        return this.toProposal(p, quote);
      } catch (e) {
        if (e instanceof AdapterError && !RETRYABLE.has(e.code)) throw e;
        lastError = e;
      }
    }
    throw new AdapterError(
      'QUOTE_FAILED',
      `no executable quote after ${attempts} attempts: ${String(lastError)}`,
    );
  }

  private async fetchQuote(p: SwapPayload): Promise<ZeroExQuote> {
    const url = new URL('/swap/allowance-holder/quote', this.cfg.baseUrl ?? ZEROX_BASE_URL);
    url.searchParams.set('chainId', String(p.originChainId));
    url.searchParams.set('sellToken', p.sellToken);
    url.searchParams.set('buyToken', p.buyToken);
    url.searchParams.set('sellAmount', p.sellAmount);
    url.searchParams.set('taker', p.recipient);
    // `recipient` is sent explicitly rather than defaulting to taker, so the
    // proceeds land where the agent signed for even if taker differs later.
    url.searchParams.set('recipient', p.recipient);

    let res: Response;
    try {
      res = await this.fetch(url.toString(), {
        headers: { '0x-api-key': this.cfg.apiKey, '0x-version': 'v2' },
      });
    } catch (e) {
      throw new AdapterError('NETWORK', `0x request failed: ${String(e)}`);
    }

    if (res.status === 429 || res.status >= 500) {
      throw new AdapterError('UPSTREAM', `0x returned ${res.status}`);
    }
    if (!res.ok) {
      // 4xx is a bad request from us; retrying sends the same bad request.
      throw new AdapterError('QUOTE_REJECTED', `0x returned ${res.status}`);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new AdapterError('UPSTREAM', '0x returned a body that is not JSON');
    }
    if (typeof body !== 'object' || body === null) {
      throw new AdapterError('UPSTREAM', '0x returned a non-object body');
    }
    return body as ZeroExQuote;
  }

  /** Turn a quote into a proposal, refusing anything structurally unusable.
   * Semantic checks against the agent's intent happen in
   * `validateExecutionProposal`, which runs again before authorization. */
  private toProposal(p: SwapPayload, q: ZeroExQuote): ExecutionProposal {
    if (q.liquidityAvailable !== true) {
      throw new AdapterError('NO_LIQUIDITY', 'no liquidity available for this pair and size');
    }
    if (!isUint(q.minBuyAmount ?? undefined)) {
      throw new AdapterError('BAD_QUOTE', 'quote has no usable minBuyAmount');
    }
    if (!isUint(q.sellAmount ?? undefined) || !isUint(q.buyAmount ?? undefined)) {
      throw new AdapterError('BAD_QUOTE', 'quote has no usable amounts');
    }
    const tx = q.transaction;
    if (!tx || !isAddress(tx.to) || typeof tx.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(tx.data)) {
      throw new AdapterError('BAD_QUOTE', 'quote has no usable transaction');
    }

    // Issues the venue itself flagged. `simulationIncomplete` means 0x could
    // not simulate the trade, so its own numbers are unverified — treating that
    // as executable is how a swap reverts on-chain with real gas spent.
    const issues = q.issues ?? {};
    if (issues.simulationIncomplete === true) {
      throw new AdapterError('SIMULATION_INCOMPLETE', '0x could not simulate this trade');
    }
    if (issues.balance && isUint(issues.balance.actual ?? undefined) && isUint(issues.balance.expected ?? undefined)) {
      if (BigInt(issues.balance.actual!) < BigInt(issues.balance.expected!)) {
        throw new AdapterError(
          'INSUFFICIENT_BALANCE',
          `taker holds ${issues.balance.actual} of ${issues.balance.expected} required`,
        );
      }
    }

    const approvals: ProposedApproval[] = [];
    if (issues.allowance) {
      const spender = issues.allowance.spender;
      const target = q.allowanceTarget;
      if (!isAddress(spender)) throw new AdapterError('BAD_QUOTE', 'allowance issue has no usable spender');
      // The spender must be the AllowanceHolder the response named, and that
      // address must be one the operator trusts. Both, not either.
      if (!isAddress(target) || !eq(spender, target)) {
        throw new AdapterError(
          'UNSAFE_ALLOWANCE_TARGET',
          `allowance spender ${spender} does not match allowanceTarget ${String(target)}`,
        );
      }
      const trusted = (this.cfg.trustedAllowanceTargets[p.originChainId] ?? []).map((a) => a.toLowerCase());
      if (!trusted.includes(spender.toLowerCase())) {
        throw new AdapterError(
          'UNSAFE_ALLOWANCE_TARGET',
          `allowance spender ${spender} is not in trusted config for chain ${p.originChainId}`,
        );
      }
      approvals.push({
        token: p.sellToken,
        spender,
        // Exactly this trade, never unbounded. An infinite approval outlives
        // the intent that justified it.
        amount: p.sellAmount,
        call: { to: p.sellToken, data: '0x', value: '0' },
      });
    }

    const call = {
      to: tx.to,
      data: tx.data as Hex,
      value: isUint(tx.value ?? undefined) ? tx.value! : '0',
      ...(isUint(tx.gas ?? undefined) ? { gas: tx.gas! } : {}),
      ...(isUint(tx.gasPrice ?? undefined) ? { gasPrice: tx.gasPrice! } : {}),
    };

    const ttl = this.cfg.quoteTtlSecs ?? DEFAULT_TTL;
    const proposal: ExecutionProposal = {
      adapterId: this.id,
      adapterVersion: this.version,
      quoteId: typeof q.zid === 'string' ? q.zid : 'unknown',
      buyAmount: q.buyAmount!,
      minBuyAmount: q.minBuyAmount!,
      sellAmount: q.sellAmount!,
      buyToken: (q.buyToken && isAddress(q.buyToken) ? q.buyToken : p.buyToken) as Hex,
      sellToken: (q.sellToken && isAddress(q.sellToken) ? q.sellToken : p.sellToken) as Hex,
      chainId: p.originChainId,
      approvals,
      call,
      // Never past the agent's own deadline, however generous the TTL.
      expiresAt: Math.min(this.now() + ttl, p.deadline),
      raw: q,
    };
    this.proposals.set(proposal.quoteId, proposal);
    return proposal;
  }

  /**
   * The last line of defence, run again immediately before authorization.
   *
   * Collects every problem rather than stopping at the first, so an operator
   * sees the whole picture instead of fixing one issue at a time.
   */
  validateExecutionProposal(intent: RevealedIntent, proposal: ExecutionProposal): ValidationResult {
    const p = intent.payload as SwapPayload;
    const issues: ValidationIssue[] = [];
    const bad = (code: string, message: string) => issues.push({ code, message });

    if (proposal.adapterId !== this.id) bad('WRONG_ADAPTER', `proposal is from ${proposal.adapterId}`);
    if (proposal.chainId !== p.originChainId) {
      bad('WRONG_CHAIN', `proposal is for chain ${proposal.chainId}, intent is for ${p.originChainId}`);
    }
    if (!eq(proposal.sellToken, p.sellToken)) bad('WRONG_SELL_TOKEN', `proposal sells ${proposal.sellToken}`);
    if (!eq(proposal.buyToken, p.buyToken)) bad('WRONG_BUY_TOKEN', `proposal buys ${proposal.buyToken}`);

    try {
      if (BigInt(proposal.sellAmount) !== BigInt(p.sellAmount)) {
        // Partial fills are opt-in. Selling less than signed without permission
        // leaves the agent with a position it did not ask for.
        if (!p.allowPartialFill || BigInt(proposal.sellAmount) > BigInt(p.sellAmount)) {
          bad('WRONG_SELL_AMOUNT', `proposal sells ${proposal.sellAmount}, intent signed ${p.sellAmount}`);
        }
      }
      // THE check. Against minBuyAmount, never buyAmount.
      if (BigInt(proposal.minBuyAmount) < BigInt(p.minimumBuyAmount)) {
        bad(
          'BELOW_MINIMUM',
          `guaranteed ${proposal.minBuyAmount} is under the signed floor ${p.minimumBuyAmount}`,
        );
      }
    } catch {
      bad('BAD_AMOUNT', 'proposal amounts are not decimal integers');
    }

    if (proposal.expiresAt <= this.now()) bad('QUOTE_EXPIRED', 'quote has expired');
    if (proposal.expiresAt > p.deadline) bad('PAST_DEADLINE', 'quote outlives the signed deadline');

    if (!isAddress(proposal.call.to)) bad('BAD_TARGET', 'call target is not an address');
    if (!/^0x[0-9a-fA-F]*$/.test(proposal.call.data)) bad('BAD_CALLDATA', 'calldata is not hex');
    if (!isUint(proposal.call.value)) bad('BAD_VALUE', 'call value is not a uint');

    const trusted = (this.cfg.trustedAllowanceTargets[p.originChainId] ?? []).map((a) => a.toLowerCase());
    for (const a of proposal.approvals) {
      if (!trusted.includes(a.spender.toLowerCase())) {
        bad('UNSAFE_ALLOWANCE_TARGET', `approval spender ${a.spender} is not trusted`);
      }
      if (!eq(a.token, p.sellToken)) bad('WRONG_APPROVAL_TOKEN', `approval is for ${a.token}`);
      try {
        if (BigInt(a.amount) > BigInt(p.sellAmount)) {
          bad('OVERBROAD_APPROVAL', `approval of ${a.amount} exceeds the ${p.sellAmount} being sold`);
        }
      } catch {
        bad('BAD_AMOUNT', 'approval amount is not a decimal integer');
      }
    }

    return { ok: issues.length === 0, issues };
  }

  async execute(
    intent: RevealedIntent,
    proposal: ExecutionProposal,
    authorization: ExecutionAuthorization,
  ): Promise<ExecutionHandle> {
    // Validate once more at the very last moment. Time has passed since the
    // agent looked, and a quote that was fine then may have expired since.
    const check = this.validateExecutionProposal(intent, proposal);
    if (!check.ok) {
      throw new AdapterError('VALIDATION_FAILED', check.issues.map((i) => i.code).join(','));
    }
    const expectedQuote = await quoteHash(proposal);
    const expectedCall = await callHash(proposal);
    if (authorization.quoteHash !== expectedQuote || authorization.callHash !== expectedCall) {
      // The agent authorized a different transaction than the one in hand.
      throw new AdapterError('AUTHORIZATION_MISMATCH', 'authorization does not cover this proposal');
    }
    if (authorization.intentId !== intent.envelope.intentId) {
      throw new AdapterError('AUTHORIZATION_MISMATCH', 'authorization is for a different intent');
    }

    // Submission itself is the TransactionSubmissionProvider's job — see
    // submission.ts. This adapter never broadcasts, so it can never quietly
    // downgrade a private submission to a public one.
    throw new AdapterError(
      'NOT_IMPLEMENTED',
      'ZeroExAdapter does not broadcast; pass the validated proposal to a TransactionSubmissionProvider',
    );
  }

  async getStatus(executionId: string): Promise<ExecutionStatusReport> {
    const known = this.executions.get(executionId);
    if (known) return known;
    return { executionId, phase: 'PENDING' };
  }

  async buildReceiptData(executionId: string): Promise<ReceiptData> {
    const status = await this.getStatus(executionId);
    const out: ReceiptData = {
      adapterId: this.id,
      adapterVersion: this.version,
      quoteHash: executionId,
    };
    if (status.originTransactionHash) out.originTransactionHash = status.originTransactionHash;
    if (status.settledSellAmount) out.settledSellAmount = status.settledSellAmount;
    if (status.settledBuyAmount) out.settledBuyAmount = status.settledBuyAmount;
    if (status.fees) out.fees = status.fees;
    if (status.errorCode) out.errorCode = status.errorCode;
    return out;
  }

  /** Record a settlement outcome observed by the submission layer. */
  recordSettlement(report: ExecutionStatusReport): void {
    this.executions.set(report.executionId, report);
  }
}

/** Codes worth another attempt. Everything else is a definite no, and retrying
 * a definite no just spends the deadline. */
const RETRYABLE: ReadonlySet<string> = new Set(['NETWORK', 'UPSTREAM']);
