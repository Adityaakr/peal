/** Across adapter — cross-chain actions, behind a feature flag.
 *
 * Shapes verified against docs.across.to at implementation time: base
 * `https://app.across.to/api`, `GET /swap/approval`, bearer auth, and a
 * response carrying `approvalTxns`, `swapTx`, `expectedOutputAmount`,
 * `minOutputAmount`, `checks`, `fees`, and an expiry.
 *
 * Ships disabled (`enabled: false` by default). The interface, the validation
 * and the tests are real; live credentials are not assumed. Turning it on is an
 * explicit operator decision, not a side effect of having the code present.
 *
 * The thing this adapter must not do, and the reason it is separate from the 0x
 * one: **a cross-chain fill is not a swap that happens to take longer.** Origin
 * confirmation says nothing about whether the destination was ever filled.
 * Funds can sit in flight, or come back as a refund on the origin chain. A UI
 * that collapses those into "confirmed" tells the agent it has ETH on Base when
 * it has USDC on Arbitrum, so the settlement phases stay distinct all the way
 * through to the receipt.
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

export const ACROSS_BASE_URL = 'https://app.across.to/api';
const ADAPTER_ID = 'across-swap-v1';
const ADAPTER_VERSION = '1';

interface AcrossTx {
  to?: string;
  data?: string;
  value?: string | null;
  chainId?: number;
}

interface AcrossQuote {
  approvalTxns?: AcrossTx[] | null;
  swapTx?: AcrossTx | null;
  expectedOutputAmount?: string | null;
  minOutputAmount?: string | null;
  inputAmount?: string | null;
  checks?: {
    allowance?: { actual?: string | null; expected?: string | null; spender?: string } | null;
    balance?: { actual?: string | null; expected?: string | null } | null;
  } | null;
  fees?: Record<string, unknown> | null;
  expiry?: number | null;
  timestamp?: number | null;
}

export interface AcrossConfig {
  /** Off unless an operator turns it on. */
  enabled?: boolean;
  apiKey?: string;
  integratorId?: string;
  baseUrl?: string;
  /** Routes this deployment will serve, as `originChainId:destinationChainId`.
   * Across supports far more than any one deployment should silently attempt. */
  supportedRoutes: readonly string[];
  trustedAllowanceTargets: Readonly<Record<number, readonly string[]>>;
  /** Ceiling on total fees, in basis points of the input amount. A bridge quote
   * with a surprising fee is the common way value leaks here. */
  maxFeeBps?: number;
  quoteTtlSecs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DEFAULT_TTL = 60;

function isAddress(v: unknown): v is Hex {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}
function isUint(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]+$/.test(v);
}
function eq(a: string | undefined, b: string | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

export function routeKey(origin: number, destination: number): string {
  return `${origin}:${destination}`;
}

export class AcrossAdapter implements ExecutionAdapter {
  readonly id = ADAPTER_ID;
  readonly version = ADAPTER_VERSION;

  private readonly executions = new Map<string, ExecutionStatusReport>();

  constructor(private readonly cfg: AcrossConfig) {}

  get enabled(): boolean {
    return this.cfg.enabled === true;
  }

  private get fetch(): typeof fetch {
    return this.cfg.fetchImpl ?? globalThis.fetch;
  }

  private now(): number {
    return this.cfg.now ? this.cfg.now() : Math.floor(Date.now() / 1000);
  }

  supports(intent: RevealedIntent): boolean {
    if (!this.enabled) return false;
    const p = intent.payload;
    return (
      p.actionType === 'swap' &&
      // Cross-chain only. A same-chain intent belongs to the 0x adapter.
      p.originChainId !== p.destinationChainId &&
      this.cfg.supportedRoutes.includes(routeKey(p.originChainId, p.destinationChainId))
    );
  }

  validateIntent(intent: RevealedIntent): void {
    if (!this.enabled) throw new AdapterError('DISABLED', 'the Across adapter is not enabled');
    const p = intent.payload as SwapPayload;
    if (p.originChainId === p.destinationChainId) {
      throw new AdapterError('UNSUPPORTED', 'same-chain intents do not belong to a bridge adapter');
    }
    if (!this.cfg.supportedRoutes.includes(routeKey(p.originChainId, p.destinationChainId))) {
      throw new AdapterError(
        'UNSUPPORTED_ROUTE',
        `route ${routeKey(p.originChainId, p.destinationChainId)} is not configured`,
      );
    }
    if (!isAddress(p.refundAddress)) {
      // On a bridge this is not cosmetic: a failed fill returns funds here.
      throw new AdapterError('BAD_REFUND_ADDRESS', 'a cross-chain intent needs a valid refund address');
    }
    if (p.deadline <= this.now()) throw new AdapterError('EXPIRED', 'intent deadline has already passed');
    if (BigInt(p.minimumBuyAmount) <= 0n) {
      throw new AdapterError('BAD_AMOUNT', 'minimumBuyAmount must be positive');
    }
    if (p.excludedAdapters.includes(this.id)) throw new AdapterError('EXCLUDED', 'the agent excluded this adapter');
  }

  async getExecutionProposal(intent: RevealedIntent, lifecycle: IntentLifecycle): Promise<ExecutionProposal> {
    assertMayQuote(lifecycle);
    this.validateIntent(intent);
    const p = intent.payload as SwapPayload;

    const url = new URL('/swap/approval', this.cfg.baseUrl ?? ACROSS_BASE_URL);
    url.searchParams.set('originChainId', String(p.originChainId));
    url.searchParams.set('destinationChainId', String(p.destinationChainId));
    url.searchParams.set('inputToken', p.sellToken);
    url.searchParams.set('outputToken', p.buyToken);
    url.searchParams.set('amount', p.sellAmount);
    url.searchParams.set('depositor', p.recipient);
    url.searchParams.set('recipient', p.recipient);
    url.searchParams.set('tradeType', 'minOutput');
    if (this.cfg.integratorId) url.searchParams.set('integratorId', this.cfg.integratorId);

    let res: Response;
    try {
      res = await this.fetch(url.toString(), {
        headers: this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {},
      });
    } catch (e) {
      throw new AdapterError('NETWORK', `Across request failed: ${String(e)}`);
    }
    if (res.status === 429 || res.status >= 500) throw new AdapterError('UPSTREAM', `Across returned ${res.status}`);
    if (!res.ok) throw new AdapterError('UNSUPPORTED_ROUTE', `Across returned ${res.status}`);

    let q: AcrossQuote;
    try {
      q = (await res.json()) as AcrossQuote;
    } catch {
      throw new AdapterError('UPSTREAM', 'Across returned a body that is not JSON');
    }
    return this.toProposal(p, q);
  }

  private toProposal(p: SwapPayload, q: AcrossQuote): ExecutionProposal {
    if (!isUint(q.minOutputAmount ?? undefined)) {
      throw new AdapterError('BAD_QUOTE', 'quote has no usable minOutputAmount');
    }
    const swapTx = q.swapTx;
    if (!swapTx || !isAddress(swapTx.to) || typeof swapTx.data !== 'string') {
      throw new AdapterError('BAD_QUOTE', 'quote has no usable swapTx');
    }
    // A bridge returns a transaction for the ORIGIN chain. One addressed to any
    // other chain would be submitted to the wrong network.
    if (typeof swapTx.chainId === 'number' && swapTx.chainId !== p.originChainId) {
      throw new AdapterError('WRONG_CHAIN', `swapTx targets chain ${swapTx.chainId}, expected ${p.originChainId}`);
    }

    const balance = q.checks?.balance;
    if (balance && isUint(balance.actual ?? undefined) && isUint(balance.expected ?? undefined)) {
      if (BigInt(balance.actual!) < BigInt(balance.expected!)) {
        throw new AdapterError('INSUFFICIENT_BALANCE', `holds ${balance.actual} of ${balance.expected}`);
      }
    }

    const approvals: ProposedApproval[] = [];
    const allowance = q.checks?.allowance;
    const needsApproval =
      allowance &&
      isUint(allowance.actual ?? undefined) &&
      isUint(allowance.expected ?? undefined) &&
      BigInt(allowance.actual!) < BigInt(allowance.expected!);
    if (needsApproval) {
      const spender = allowance?.spender;
      if (!isAddress(spender)) throw new AdapterError('BAD_QUOTE', 'allowance check has no usable spender');
      const trusted = (this.cfg.trustedAllowanceTargets[p.originChainId] ?? []).map((a) => a.toLowerCase());
      if (!trusted.includes(spender.toLowerCase())) {
        throw new AdapterError(
          'UNSAFE_ALLOWANCE_TARGET',
          `spender ${spender} is not in trusted config for chain ${p.originChainId}`,
        );
      }
      approvals.push({
        token: p.sellToken,
        spender,
        amount: p.sellAmount,
        call: { to: p.sellToken, data: '0x', value: '0' },
      });
    }

    const ttl = this.cfg.quoteTtlSecs ?? DEFAULT_TTL;
    const venueExpiry = typeof q.expiry === 'number' && q.expiry > 0 ? q.expiry : this.now() + ttl;

    return {
      adapterId: this.id,
      adapterVersion: this.version,
      quoteId: `across_${p.originChainId}_${p.destinationChainId}_${q.timestamp ?? 0}`,
      buyAmount: isUint(q.expectedOutputAmount ?? undefined) ? q.expectedOutputAmount! : q.minOutputAmount!,
      minBuyAmount: q.minOutputAmount!,
      sellAmount: isUint(q.inputAmount ?? undefined) ? q.inputAmount! : p.sellAmount,
      buyToken: p.buyToken,
      sellToken: p.sellToken,
      chainId: p.originChainId,
      approvals,
      call: {
        to: swapTx.to,
        data: swapTx.data as Hex,
        value: isUint(swapTx.value ?? undefined) ? swapTx.value! : '0',
      },
      // The earliest of: venue expiry, our TTL, the agent's deadline.
      expiresAt: Math.min(venueExpiry, this.now() + ttl, p.deadline),
      raw: q,
    };
  }

  validateExecutionProposal(intent: RevealedIntent, proposal: ExecutionProposal): ValidationResult {
    const p = intent.payload as SwapPayload;
    const issues: ValidationIssue[] = [];
    const bad = (code: string, message: string) => issues.push({ code, message });

    if (proposal.adapterId !== this.id) bad('WRONG_ADAPTER', `proposal is from ${proposal.adapterId}`);
    if (proposal.chainId !== p.originChainId) bad('WRONG_CHAIN', `proposal is for chain ${proposal.chainId}`);
    if (!eq(proposal.sellToken, p.sellToken)) bad('WRONG_SELL_TOKEN', `proposal sells ${proposal.sellToken}`);
    if (!eq(proposal.buyToken, p.buyToken)) bad('WRONG_BUY_TOKEN', `proposal buys ${proposal.buyToken}`);

    try {
      if (BigInt(proposal.minBuyAmount) < BigInt(p.minimumBuyAmount)) {
        bad('BELOW_MINIMUM', `guaranteed ${proposal.minBuyAmount} is under the floor ${p.minimumBuyAmount}`);
      }
      if (BigInt(proposal.sellAmount) > BigInt(p.sellAmount)) {
        bad('WRONG_SELL_AMOUNT', `proposal sells ${proposal.sellAmount}, intent signed ${p.sellAmount}`);
      }
      // Fee ceiling, in bps of the input. maximumFee is in sell-token units.
      if (this.cfg.maxFeeBps !== undefined) {
        const cap = (BigInt(p.sellAmount) * BigInt(this.cfg.maxFeeBps)) / 10_000n;
        if (BigInt(p.maximumFee) > 0n && cap > BigInt(p.maximumFee)) {
          bad('FEE_TOO_HIGH', `route fee cap ${cap} exceeds the agent's maximumFee ${p.maximumFee}`);
        }
      }
    } catch {
      bad('BAD_AMOUNT', 'proposal amounts are not decimal integers');
    }

    if (proposal.expiresAt <= this.now()) bad('QUOTE_EXPIRED', 'quote has expired');
    if (proposal.expiresAt > p.deadline) bad('PAST_DEADLINE', 'quote outlives the signed deadline');

    const trusted = (this.cfg.trustedAllowanceTargets[p.originChainId] ?? []).map((a) => a.toLowerCase());
    for (const a of proposal.approvals) {
      if (!trusted.includes(a.spender.toLowerCase())) {
        bad('UNSAFE_ALLOWANCE_TARGET', `approval spender ${a.spender} is not trusted`);
      }
    }
    return { ok: issues.length === 0, issues };
  }

  async execute(
    _intent: RevealedIntent,
    _proposal: ExecutionProposal,
    _authorization: ExecutionAuthorization,
  ): Promise<ExecutionHandle> {
    throw new AdapterError(
      'NOT_IMPLEMENTED',
      'AcrossAdapter does not broadcast; pass the validated proposal to a TransactionSubmissionProvider',
    );
  }

  async getStatus(executionId: string): Promise<ExecutionStatusReport> {
    return this.executions.get(executionId) ?? { executionId, phase: 'PENDING' };
  }

  async buildReceiptData(executionId: string): Promise<ReceiptData> {
    const s = await this.getStatus(executionId);
    const out: ReceiptData = { adapterId: this.id, adapterVersion: this.version, quoteHash: executionId };
    if (s.originTransactionHash) out.originTransactionHash = s.originTransactionHash;
    // Only set once the destination actually filled. A receipt claiming a
    // destination hash for an in-flight deposit would be a lie about where the
    // agent's funds are.
    if (s.phase === 'DESTINATION_FILLED' && s.destinationTransactionHash) {
      out.destinationTransactionHash = s.destinationTransactionHash;
    }
    if (s.settledSellAmount) out.settledSellAmount = s.settledSellAmount;
    if (s.settledBuyAmount) out.settledBuyAmount = s.settledBuyAmount;
    if (s.fees) out.fees = s.fees;
    if (s.errorCode) out.errorCode = s.errorCode;
    else if (s.phase === 'REFUNDED') out.errorCode = 'REFUNDED';
    return out;
  }

  recordSettlement(report: ExecutionStatusReport): void {
    this.executions.set(report.executionId, report);
  }
}
