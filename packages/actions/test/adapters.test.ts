import { describe, expect, it } from 'vitest';
import { AdapterError, PrematureQuoteError, type RevealedIntent } from '../src/adapter.js';
import { ZeroExAdapter, ZEROX_BASE_URL, quoteHash } from '../src/adapters/zerox.js';
import { AcrossAdapter, routeKey } from '../src/adapters/across.js';
import { IntentLifecycle, STATES, type IntentState } from '../src/state.js';
import { PAYLOAD_VERSION, PROTOCOL_VERSION, type Hex, type IntentEnvelope, type SwapPayload } from '../src/intent.js';
import {
  DEGRADED_PRIVACY_WARNING,
  DegradedPrivacyError,
  SimulatedSubmissionProvider,
  selectProvider,
  type TransactionSubmissionProvider,
} from '../src/submission.js';

const NOW = 1_700_000_000;
const now = () => NOW;
const TAKER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';
const ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734';
const SETTLER = '0x5555555555555555555555555555555555555555';
const ROUTER = '0x1111111111111111111111111111111111111111';

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
    recipient: TAKER,
    refundAddress: TAKER,
    deadline: NOW + 600,
    maximumFee: '5000000',
    preferredAdapters: [],
    excludedAdapters: [],
    allowPartialFill: false,
    privateSubmissionRequired: false,
    ...over,
  };
}

function intent(over: Partial<SwapPayload> = {}): RevealedIntent {
  const envelope: IntentEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    intentId: 'intent_abc12345',
    encryptionKeyId: 'a'.repeat(64),
    ciphertextHash: 'b'.repeat(64),
    nonce: 'nonce_0000001',
    createdAt: NOW,
    expiresAt: NOW + 300,
    pseudonymousSigner: TAKER,
    executionDomain: 8453,
  };
  return { envelope, payload: payload(over) };
}

/** A 0x v2 quote, shaped exactly as docs.0x.org describes it. */
function quote(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    liquidityAvailable: true,
    zid: '0xzid',
    allowanceTarget: ALLOWANCE_HOLDER,
    buyAmount: '14350000000000000000',
    minBuyAmount: '14300000000000000000',
    sellAmount: '50000000000',
    buyToken: WETH,
    sellToken: USDC,
    transaction: { to: ROUTER, data: '0xdeadbeef', value: '0', gas: '250000' },
    issues: { balance: null, allowance: null, simulationIncomplete: false, invalidSourcesPassed: [] },
    ...over,
  };
}

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

/** Assert an AdapterError code. Codes are the stable contract between the
 * adapter and its callers; messages are prose and free to change. */
async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    expect(e, `expected an AdapterError, got ${String(e)}`).toBeInstanceOf(AdapterError);
    expect((e as AdapterError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

function expectCodeSync(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AdapterError);
    expect((e as AdapterError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

function zerox(over: Partial<ConstructorParameters<typeof ZeroExAdapter>[0]> = {}) {
  return new ZeroExAdapter({
    apiKey: 'test-key',
    supportedChainIds: [8453],
    trustedAllowanceTargets: { 8453: [ALLOWANCE_HOLDER] },
    fetchImpl: fetchReturning(quote()),
    now,
    ...over,
  });
}

const revealed = () => new IntentLifecycle('i', 'REVEALED', now);

describe('the quote gate', () => {
  // The single most important behaviour in the adapter layer.
  it('refuses to contact a liquidity provider from any pre-reveal state', async () => {
    let called = false;
    const a = zerox({
      fetchImpl: (async () => {
        called = true;
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    const early = STATES.filter((s) => s !== 'REVEALED' && s !== 'QUOTING');
    for (const s of early) {
      await expect(
        a.getExecutionProposal(intent(), new IntentLifecycle('i', s as IntentState, now)),
        `state ${s}`,
      ).rejects.toThrow(PrematureQuoteError);
    }
    expect(called, 'no network call may happen before reveal').toBe(false);
  });

  it('allows it once revealed', async () => {
    const p = await zerox().getExecutionProposal(intent(), revealed());
    expect(p.adapterId).toBe('zerox-swap-v2');
  });

  it('checks the gate before validating the intent, so an invalid one still cannot leak', async () => {
    let called = false;
    const a = zerox({
      fetchImpl: (async () => {
        called = true;
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    // Expired intent AND wrong state: must fail on the privacy gate, not the
    // deadline, and must not reach the network either way.
    await expect(
      a.getExecutionProposal(intent({ deadline: NOW - 1 }), new IntentLifecycle('i', 'BATCHED', now)),
    ).rejects.toThrow(PrematureQuoteError);
    expect(called).toBe(false);
  });
});

describe('0x adapter: request shape', () => {
  it('calls Swap API v2 allowance-holder, never v1', async () => {
    let seen = '';
    let headers: Record<string, string> = {};
    const a = zerox({
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = url;
        headers = init.headers as Record<string, string>;
        return new Response(JSON.stringify(quote()));
      }) as unknown as typeof fetch,
    });
    await a.getExecutionProposal(intent(), revealed());
    expect(seen.startsWith(`${ZEROX_BASE_URL}/swap/allowance-holder/quote`)).toBe(true);
    expect(seen).not.toContain('/swap/v1/');
    const u = new URL(seen);
    expect(u.searchParams.get('chainId')).toBe('8453');
    expect(u.searchParams.get('sellToken')).toBe(USDC);
    expect(u.searchParams.get('buyToken')).toBe(WETH);
    expect(u.searchParams.get('sellAmount')).toBe('50000000000');
    expect(u.searchParams.get('taker')).toBe(TAKER);
    expect(headers['0x-version']).toBe('v2');
    expect(headers['0x-api-key']).toBe('test-key');
  });

  it('never puts the api key in the url', async () => {
    let seen = '';
    const a = zerox({
      fetchImpl: (async (url: string) => {
        seen = url;
        return new Response(JSON.stringify(quote()));
      }) as unknown as typeof fetch,
    });
    await a.getExecutionProposal(intent(), revealed());
    expect(seen).not.toContain('test-key');
  });
});

describe('0x adapter: refusing bad quotes', () => {
  const rejects = async (over: Record<string, unknown>, code: string) => {
    const a = zerox({ fetchImpl: fetchReturning(quote(over)) });
    await expect(a.getExecutionProposal(intent(), revealed())).rejects.toThrow(
      expect.objectContaining({ code }) as never,
    );
  };

  it('fails safely when there is no liquidity', () => rejects({ liquidityAvailable: false }, 'NO_LIQUIDITY'));

  it('refuses a quote 0x could not simulate', () =>
    rejects({ issues: { simulationIncomplete: true } }, 'SIMULATION_INCOMPLETE'));

  it('refuses when the taker cannot cover the trade', () =>
    rejects(
      { issues: { balance: { token: USDC, actual: '1', expected: '50000000000' }, simulationIncomplete: false } },
      'INSUFFICIENT_BALANCE',
    ));

  it('refuses a quote with no minBuyAmount', () => rejects({ minBuyAmount: null }, 'BAD_QUOTE'));

  it('refuses a quote with no transaction', () => rejects({ transaction: null }, 'BAD_QUOTE'));

  it('refuses a transaction target that is not an address', () =>
    rejects({ transaction: { to: 'not-an-address', data: '0x' } }, 'BAD_QUOTE'));

  it('refuses calldata that is not hex', () =>
    rejects({ transaction: { to: ROUTER, data: 'DROP TABLE' } }, 'BAD_QUOTE'));

  it('refuses an allowance spender that is not the returned allowanceTarget', () =>
    rejects(
      {
        allowanceTarget: ALLOWANCE_HOLDER,
        issues: { allowance: { actual: '0', spender: SETTLER }, simulationIncomplete: false },
      },
      'UNSAFE_ALLOWANCE_TARGET',
    ));

  it('refuses an allowance target the operator does not trust', () =>
    // Even when 0x names it consistently: the Settler contract must never be
    // approved, and only configured targets are acceptable.
    rejects(
      {
        allowanceTarget: SETTLER,
        issues: { allowance: { actual: '0', spender: SETTLER }, simulationIncomplete: false },
      },
      'UNSAFE_ALLOWANCE_TARGET',
    ));

  it('accepts an approval to the trusted allowance holder, bounded to this trade', async () => {
    const a = zerox({
      fetchImpl: fetchReturning(
        quote({
          allowanceTarget: ALLOWANCE_HOLDER,
          issues: { allowance: { actual: '0', spender: ALLOWANCE_HOLDER }, simulationIncomplete: false },
        }),
      ),
    });
    const p = await a.getExecutionProposal(intent(), revealed());
    expect(p.approvals).toHaveLength(1);
    expect(p.approvals[0]!.spender).toBe(ALLOWANCE_HOLDER);
    // Never unbounded: an infinite approval outlives the intent that justified it.
    expect(p.approvals[0]!.amount).toBe('50000000000');
  });

  it('does not retry a 4xx, which would just resend the same bad request', async () => {
    let calls = 0;
    const a = zerox({
      fetchImpl: (async () => {
        calls++;
        return new Response('{}', { status: 400 });
      }) as unknown as typeof fetch,
    });
    await expectCode(() => a.getExecutionProposal(intent(), revealed()), 'QUOTE_REJECTED');
    expect(calls).toBe(1);
  });

  it('retries a 500 up to the configured bound and then gives up', async () => {
    let calls = 0;
    const a = zerox({
      maxAttempts: 3,
      fetchImpl: (async () => {
        calls++;
        return new Response('{}', { status: 503 });
      }) as unknown as typeof fetch,
    });
    await expectCode(() => a.getExecutionProposal(intent(), revealed()), 'QUOTE_FAILED');
    expect(calls).toBe(3);
  });

  it('stops retrying once the deadline has passed', async () => {
    let calls = 0;
    let t = NOW;
    const a = zerox({
      maxAttempts: 5,
      now: () => t,
      fetchImpl: (async () => {
        calls++;
        t = NOW + 10_000; // deadline blows past mid-loop
        return new Response('{}', { status: 503 });
      }) as unknown as typeof fetch,
    });
    await expectCode(() => a.getExecutionProposal(intent(), revealed()), 'EXPIRED');
    expect(calls).toBe(1);
  });
});

describe('0x adapter: validating against what the agent signed', () => {
  const check = async (over: Record<string, unknown>) => {
    const a = zerox({ fetchImpl: fetchReturning(quote(over)) });
    const i = intent();
    const p = await a.getExecutionProposal(i, revealed());
    return { a, i, p };
  };

  it('accepts a quote that clears the floor', async () => {
    const { a, i, p } = await check({});
    expect(a.validateExecutionProposal(i, p)).toEqual({ ok: true, issues: [] });
  });

  it('rejects a guaranteed minimum below the signed floor', async () => {
    // The core commercial guarantee. minBuyAmount, not buyAmount.
    const { a, i, p } = await check({ minBuyAmount: '14000000000000000000' });
    const r = a.validateExecutionProposal(i, p);
    expect(r.ok).toBe(false);
    expect(r.issues.map((x) => x.code)).toContain('BELOW_MINIMUM');
  });

  it('is not fooled by a high buyAmount hiding a low minBuyAmount', async () => {
    const { a, i, p } = await check({ buyAmount: '99000000000000000000', minBuyAmount: '1' });
    expect(a.validateExecutionProposal(i, p).issues.map((x) => x.code)).toContain('BELOW_MINIMUM');
  });

  it('accepts exactly the floor', async () => {
    const { a, i, p } = await check({ minBuyAmount: '14200000000000000000' });
    expect(a.validateExecutionProposal(i, p).ok).toBe(true);
  });

  it('rejects a swapped token', async () => {
    const { a, i, p } = await check({});
    const r = a.validateExecutionProposal(i, { ...p, buyToken: USDC });
    expect(r.issues.map((x) => x.code)).toContain('WRONG_BUY_TOKEN');
  });

  it('rejects a swapped chain', async () => {
    const { a, i, p } = await check({});
    expect(a.validateExecutionProposal(i, { ...p, chainId: 1 }).issues.map((x) => x.code)).toContain('WRONG_CHAIN');
  });

  it('rejects selling more than the agent signed for', async () => {
    const { a, i, p } = await check({});
    expect(
      a.validateExecutionProposal(i, { ...p, sellAmount: '60000000000' }).issues.map((x) => x.code),
    ).toContain('WRONG_SELL_AMOUNT');
  });

  it('rejects a partial fill unless the agent allowed one', async () => {
    const { a, p } = await check({});
    const strict = intent({ allowPartialFill: false });
    expect(a.validateExecutionProposal(strict, { ...p, sellAmount: '1000' }).ok).toBe(false);
    const lenient = intent({ allowPartialFill: true });
    expect(a.validateExecutionProposal(lenient, { ...p, sellAmount: '1000' }).ok).toBe(true);
  });

  it('rejects an expired quote', async () => {
    const { a, i, p } = await check({});
    expect(a.validateExecutionProposal(i, { ...p, expiresAt: NOW - 1 }).issues.map((x) => x.code)).toContain(
      'QUOTE_EXPIRED',
    );
  });

  it('rejects a quote that outlives the signed deadline', async () => {
    const { a, i, p } = await check({});
    expect(
      a.validateExecutionProposal(i, { ...p, expiresAt: NOW + 99_999 }).issues.map((x) => x.code),
    ).toContain('PAST_DEADLINE');
  });

  it('rejects an untrusted approval spender at validation time too', async () => {
    const { a, i, p } = await check({});
    const tampered = {
      ...p,
      approvals: [
        { token: USDC as Hex, spender: SETTLER as Hex, amount: '1', call: { to: USDC as Hex, data: '0x' as Hex, value: '0' } },
      ],
    };
    expect(a.validateExecutionProposal(i, tampered).issues.map((x) => x.code)).toContain('UNSAFE_ALLOWANCE_TARGET');
  });

  it('rejects an approval larger than the trade', async () => {
    const { a, i, p } = await check({});
    const tampered = {
      ...p,
      approvals: [
        {
          token: USDC as Hex,
          spender: ALLOWANCE_HOLDER as Hex,
          amount: '99999999999999',
          call: { to: USDC as Hex, data: '0x' as Hex, value: '0' },
        },
      ],
    };
    expect(a.validateExecutionProposal(i, tampered).issues.map((x) => x.code)).toContain('OVERBROAD_APPROVAL');
  });

  it('reports every problem at once', async () => {
    const { a, i, p } = await check({});
    const r = a.validateExecutionProposal(i, { ...p, chainId: 1, buyToken: USDC, expiresAt: NOW - 1 });
    expect(r.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('0x adapter: authorization binding', () => {
  it('refuses to execute against an authorization for a different quote', async () => {
    const a = zerox();
    const i = intent();
    const p = await a.getExecutionProposal(i, revealed());
    await expectCode(
      () =>
        a.execute(i, p, {
          intentId: i.envelope.intentId,
          quoteHash: 'f'.repeat(64),
          callHash: 'f'.repeat(64),
          signature: '0x00',
          submissionMode: 'private',
        }),
      'AUTHORIZATION_MISMATCH',
    );
  });

  it('changes the quote hash when any value-moving field changes', async () => {
    const a = zerox();
    const p = await a.getExecutionProposal(intent(), revealed());
    const base = await quoteHash(p);
    expect(await quoteHash({ ...p, minBuyAmount: '1' })).not.toBe(base);
    expect(await quoteHash({ ...p, call: { ...p.call, data: '0xbeef' } })).not.toBe(base);
    expect(await quoteHash({ ...p, call: { ...p.call, to: SETTLER } })).not.toBe(base);
    expect(await quoteHash({ ...p, sellAmount: '1' })).not.toBe(base);
  });

  it('does not broadcast, so it cannot downgrade a private submission', async () => {
    const a = zerox();
    const i = intent();
    const p = await a.getExecutionProposal(i, revealed());
    await expect(
      a.execute(i, p, {
        intentId: i.envelope.intentId,
        quoteHash: await quoteHash(p),
        callHash: await (await import('../src/adapters/zerox.js')).callHash(p),
        signature: '0x00',
        submissionMode: 'private',
      }),
    ).rejects.toThrow(/NOT_IMPLEMENTED|TransactionSubmissionProvider/);
  });
});

describe('0x adapter: routing', () => {
  it('does not claim cross-chain intents', () => {
    expect(zerox().supports(intent({ destinationChainId: 42161 }))).toBe(false);
  });

  it('does not claim unsupported chains', () => {
    expect(zerox().supports(intent({ originChainId: 1, destinationChainId: 1 }))).toBe(false);
  });

  it('refuses when the agent excluded it', () => {
    expectCodeSync(() => zerox().validateIntent(intent({ excludedAdapters: ['zerox-swap-v2'] })), 'EXCLUDED');
  });

  it('refuses a zero floor, which is a blank cheque', () => {
    expectCodeSync(() => zerox().validateIntent(intent({ minimumBuyAmount: '0' })), 'BAD_AMOUNT');
  });

  it('refuses when no allowance targets are configured for the chain', () => {
    const a = zerox({ trustedAllowanceTargets: {} });
    expectCodeSync(() => a.validateIntent(intent()), 'CONFIG');
  });

  it('refuses to construct without an api key', () => {
    expect(() => new ZeroExAdapter({ apiKey: '', supportedChainIds: [8453], trustedAllowanceTargets: {} })).toThrow(
      /API key/,
    );
  });
});

describe('Across adapter', () => {
  const acrossQuote = (over: Record<string, unknown> = {}) => ({
    swapTx: { to: ROUTER, data: '0xfeed', value: '0', chainId: 8453 },
    approvalTxns: [],
    expectedOutputAmount: '14350000000000000000',
    minOutputAmount: '14300000000000000000',
    inputAmount: '50000000000',
    checks: { allowance: null, balance: null },
    expiry: NOW + 120,
    timestamp: NOW,
    ...over,
  });

  const across = (over: Partial<ConstructorParameters<typeof AcrossAdapter>[0]> = {}) =>
    new AcrossAdapter({
      enabled: true,
      integratorId: 'peal',
      supportedRoutes: [routeKey(8453, 42161)],
      trustedAllowanceTargets: { 8453: [ALLOWANCE_HOLDER] },
      fetchImpl: fetchReturning(acrossQuote()),
      now,
      ...over,
    });

  const xchain = (over: Partial<SwapPayload> = {}) => intent({ destinationChainId: 42161, ...over });

  it('is off unless explicitly enabled', () => {
    const a = new AcrossAdapter({ supportedRoutes: [], trustedAllowanceTargets: {} });
    expect(a.enabled).toBe(false);
    expect(a.supports(xchain())).toBe(false);
    expectCodeSync(() => a.validateIntent(xchain()), 'DISABLED');
  });

  it('honours the same quote gate', async () => {
    await expect(
      across().getExecutionProposal(xchain(), new IntentLifecycle('i', 'BATCHED', now)),
    ).rejects.toThrow(PrematureQuoteError);
  });

  it('refuses an unsupported route', async () => {
    await expectCode(
      () => across({ supportedRoutes: [] }).getExecutionProposal(xchain(), revealed()),
      'UNSUPPORTED_ROUTE',
    );
  });

  it('does not claim same-chain intents', () => {
    expect(across().supports(intent())).toBe(false);
  });

  it('refuses a cross-chain intent with no refund address', () => {
    expectCodeSync(() => across().validateIntent(xchain({ refundAddress: '0xnope' as never })), 'BAD_REFUND_ADDRESS');
  });

  it('refuses a swapTx addressed to the wrong chain', async () => {
    const a = across({ fetchImpl: fetchReturning(acrossQuote({ swapTx: { to: ROUTER, data: '0x', chainId: 1 } })) });
    await expectCode(() => a.getExecutionProposal(xchain(), revealed()), 'WRONG_CHAIN');
  });

  it('rejects output below the signed floor', async () => {
    const a = across({ fetchImpl: fetchReturning(acrossQuote({ minOutputAmount: '1' })) });
    const i = xchain();
    const p = await a.getExecutionProposal(i, revealed());
    expect(a.validateExecutionProposal(i, p).issues.map((x) => x.code)).toContain('BELOW_MINIMUM');
  });

  it('caps the quote at the venue expiry when that is sooner', async () => {
    const a = across({ quoteTtlSecs: 9999, fetchImpl: fetchReturning(acrossQuote({ expiry: NOW + 30 })) });
    const p = await a.getExecutionProposal(xchain(), revealed());
    expect(p.expiresAt).toBe(NOW + 30);
  });

  it('never lets a quote outlive the agent deadline', async () => {
    const a = across({ quoteTtlSecs: 9999, fetchImpl: fetchReturning(acrossQuote({ expiry: NOW + 99_999 })) });
    const p = await a.getExecutionProposal(xchain({ deadline: NOW + 60 }), revealed());
    expect(p.expiresAt).toBeLessThanOrEqual(NOW + 60);
  });

  it('refuses an untrusted approval spender', async () => {
    const a = across({
      fetchImpl: fetchReturning(
        acrossQuote({ checks: { allowance: { actual: '0', expected: '50000000000', spender: SETTLER } } }),
      ),
    });
    await expectCode(() => a.getExecutionProposal(xchain(), revealed()), 'UNSAFE_ALLOWANCE_TARGET');
  });

  it('keeps in-flight distinct from filled in the receipt data', async () => {
    const a = across();
    a.recordSettlement({
      executionId: 'x1',
      phase: 'IN_FLIGHT',
      originTransactionHash: '0x' + 'ab'.repeat(32),
      destinationTransactionHash: '0x' + 'cd'.repeat(32),
    });
    const data = await a.buildReceiptData('x1');
    // Origin confirmed, destination NOT yet filled: the receipt must not claim
    // a destination hash, or the agent is told its funds arrived when they did not.
    expect(data.originTransactionHash).toBeDefined();
    expect(data.destinationTransactionHash).toBeUndefined();
  });

  it('represents a refund as a distinct outcome', async () => {
    const a = across();
    a.recordSettlement({ executionId: 'x2', phase: 'REFUNDED', originTransactionHash: '0x' + 'ab'.repeat(32) });
    expect((await a.buildReceiptData('x2')).errorCode).toBe('REFUNDED');
  });
});

describe('submission policy', () => {
  const provider = (mode: TransactionSubmissionProvider['mode'], chains: number[]): TransactionSubmissionProvider => ({
    mode,
    supportsChain: (c) => chains.includes(c),
    submit: async () => ({ executionId: 'e', mode, privateRoute: mode === 'private' || mode === 'solver' }),
    waitForSettlement: async () => ({ executionId: 'e', phase: 'DESTINATION_FILLED' }),
  });

  it('prefers a private route when one exists', () => {
    const { provider: p, degraded } = selectProvider(payload(), {
      providers: [provider('public-rpc', [8453]), provider('private', [8453])],
    });
    expect(p.mode).toBe('private');
    expect(degraded).toBe(false);
  });

  it('falls back to public RPC and flags the degradation', () => {
    const { provider: p, degraded } = selectProvider(payload(), { providers: [provider('public-rpc', [8453])] });
    expect(p.mode).toBe('public-rpc');
    expect(degraded).toBe(true);
  });

  it('refuses to execute at all when the agent required privacy and there is none', () => {
    // Not "execute and label it": the agent said do not broadcast publicly.
    expect(() =>
      selectProvider(payload({ privateSubmissionRequired: true }), {
        providers: [provider('public-rpc', [8453])],
      }),
    ).toThrow(DegradedPrivacyError);
  });

  it('ignores a provider that does not serve the chain', () => {
    expect(() =>
      selectProvider(payload({ privateSubmissionRequired: true }), {
        providers: [provider('private', [1])],
      }),
    ).toThrow(DegradedPrivacyError);
  });

  it('throws when nothing serves the chain at all', () => {
    expectCodeSync(() => selectProvider(payload(), { providers: [] }), 'NO_SUBMISSION_ROUTE');
  });

  it('states the degraded warning without softening it', () => {
    expect(DEGRADED_PRIVACY_WARNING).toMatch(/public mempool/);
    expect(DEGRADED_PRIVACY_WARNING).toMatch(/front-run or sandwiched/);
  });
});

describe('simulated submission', () => {
  it('never claims a private route or a transaction hash it does not have', async () => {
    const sim = new SimulatedSubmissionProvider([8453]);
    const a = zerox();
    const p = await a.getExecutionProposal(intent(), revealed());
    const r = await sim.submit(p, '0xsigned');
    expect(r.mode).toBe('simulated');
    expect(r.privateRoute).toBe(false);
    expect(r.originTransactionHash).toBeUndefined();
  });

  it('settles at exactly the guaranteed minimum, the pessimistic case', async () => {
    const sim = new SimulatedSubmissionProvider([8453]);
    const a = zerox();
    const p = await a.getExecutionProposal(intent(), revealed());
    const r = await sim.submit(p, '0xsigned');
    const s = await sim.waitForSettlement(r.executionId);
    expect(s.settledBuyAmount).toBe(p.minBuyAmount);
    expect(s.phase).toBe('DESTINATION_FILLED');
  });

  it('is deterministic, so a simulated run is reproducible', async () => {
    const a = zerox();
    const p = await a.getExecutionProposal(intent(), revealed());
    const one = await new SimulatedSubmissionProvider([8453]).submit(p, '0x');
    const two = await new SimulatedSubmissionProvider([8453]).submit(p, '0x');
    expect(one.executionId).toBe(two.executionId);
  });

  it('refuses to report on an execution it never ran', async () => {
    await expect(new SimulatedSubmissionProvider([8453]).waitForSettlement('nope')).rejects.toThrow(
      AdapterError,
    );
  });
});
