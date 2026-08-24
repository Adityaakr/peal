/** The intent lifecycle, as a graph the code cannot walk incorrectly.
 *
 * The important thing here is not bookkeeping, it is a safety property. Peal's
 * whole claim rests on one ordering fact:
 *
 *   No liquidity provider is contacted before inclusion and ordering are
 *   committed AND the batch has been revealed.
 *
 * A comment saying "call the adapter after reveal" is not a guarantee; a
 * refactor deletes it. So the property is made structural instead: QUOTING is
 * only reachable through ORDER_COMMITTED and REVEALED, and `test/state.test.ts`
 * proves it by exhaustive search over every path in this graph. If someone adds
 * an edge that lets an intent reach QUOTING early, that test fails.
 *
 * Transitions are also the audit trail. Every one is timestamped and persisted,
 * so a receipt can point at when ordering locked relative to when the quote was
 * requested.
 */

export const STATES = [
  'DRAFT',
  'SEALED',
  'SUBMITTED',
  'VALIDATED',
  'BATCHED',
  'ORDER_COMMITTED',
  'COLLECTING_SHARES',
  'THRESHOLD_REACHED',
  'REVEALED',
  'QUOTING',
  'QUOTE_VALIDATED',
  'AUTHORIZATION_REQUIRED',
  'AUTHORIZED',
  'SUBMITTED_FOR_EXECUTION',
  'CONFIRMED',
  'SETTLED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
] as const;

export type IntentState = (typeof STATES)[number];

/** Cross-chain settlement runs its own small machine underneath
 * SUBMITTED_FOR_EXECUTION..SETTLED, because "confirmed" on the origin chain says
 * nothing about whether the destination was ever filled. Conflating them is how
 * a bridge UI ends up claiming success for funds that are still in flight. */
export const SETTLEMENT_STATES = [
  'ORIGIN_CONFIRMED',
  'IN_FLIGHT',
  'DESTINATION_FILLED',
  'REFUNDED',
] as const;

export type SettlementState = (typeof SETTLEMENT_STATES)[number];

/** Terminal states. Nothing leaves these. */
export const TERMINAL: ReadonlySet<IntentState> = new Set<IntentState>([
  'SETTLED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
]);

/** States from which an agent may still walk away. Once the transaction has
 * been handed to a submission provider it is out of our hands, so cancellation
 * stops being offered rather than being offered and quietly ignored. */
export const CANCELLABLE: ReadonlySet<IntentState> = new Set<IntentState>([
  'DRAFT',
  'SEALED',
  'SUBMITTED',
  'VALIDATED',
  'REVEALED',
  'QUOTING',
  'QUOTE_VALIDATED',
  'AUTHORIZATION_REQUIRED',
  'AUTHORIZED',
]);

/**
 * The edge set.
 *
 * Two deliberate absences worth naming, since both look like oversights:
 *
 *  - BATCHED..THRESHOLD_REACHED cannot be CANCELLED. Once a ciphertext is in a
 *    committed batch it is part of that batch's ordering; letting an agent pull
 *    it out would be exactly the reordering power the commitment exists to
 *    remove. The agent can still decline to authorize afterwards.
 *  - Nothing skips REVEALED. Even a failure path goes through the states it
 *    actually passed, so the timeline in a receipt is real.
 */
const EDGES: Record<IntentState, readonly IntentState[]> = {
  DRAFT: ['SEALED', 'CANCELLED'],
  SEALED: ['SUBMITTED', 'CANCELLED', 'EXPIRED'],
  SUBMITTED: ['VALIDATED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  VALIDATED: ['BATCHED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  // From here to REVEALED the intent belongs to the batch, not the agent.
  BATCHED: ['ORDER_COMMITTED', 'FAILED', 'EXPIRED'],
  ORDER_COMMITTED: ['COLLECTING_SHARES', 'FAILED'],
  COLLECTING_SHARES: ['THRESHOLD_REACHED', 'FAILED', 'EXPIRED'],
  THRESHOLD_REACHED: ['REVEALED', 'FAILED'],
  // The payload is now plaintext to the executor. Only here does an external
  // liquidity call become permissible.
  REVEALED: ['QUOTING', 'FAILED', 'EXPIRED', 'CANCELLED'],
  QUOTING: ['QUOTE_VALIDATED', 'FAILED', 'EXPIRED', 'CANCELLED'],
  QUOTE_VALIDATED: ['AUTHORIZATION_REQUIRED', 'FAILED', 'EXPIRED', 'CANCELLED'],
  // The agent, not Peal, holds the key. If it never answers, the intent expires
  // unexecuted; it is never executed on the agent's behalf.
  AUTHORIZATION_REQUIRED: ['AUTHORIZED', 'CANCELLED', 'EXPIRED'],
  AUTHORIZED: ['SUBMITTED_FOR_EXECUTION', 'CANCELLED', 'FAILED', 'EXPIRED'],
  SUBMITTED_FOR_EXECUTION: ['CONFIRMED', 'FAILED'],
  CONFIRMED: ['SETTLED', 'FAILED'],
  SETTLED: [],
  FAILED: [],
  EXPIRED: [],
  CANCELLED: [],
};

/** States that must appear on every path to QUOTING. The privacy property,
 * written down where the test can read it. */
export const REQUIRED_BEFORE_QUOTING: readonly IntentState[] = ['ORDER_COMMITTED', 'REVEALED'];

export function nextStates(from: IntentState): readonly IntentState[] {
  return EDGES[from];
}

export function canTransition(from: IntentState, to: IntentState): boolean {
  return EDGES[from].includes(to);
}

export class InvalidTransition extends Error {
  constructor(
    readonly from: IntentState,
    readonly to: IntentState,
  ) {
    super(`illegal intent transition ${from} -> ${to}`);
    this.name = 'InvalidTransition';
  }
}

export function assertTransition(from: IntentState, to: IntentState): void {
  if (!canTransition(from, to)) throw new InvalidTransition(from, to);
}

export interface TransitionRecord {
  from: IntentState;
  to: IntentState;
  at: number;
  /** Short machine-readable reason, for failures and cancellations. Never a
   * free-text field containing payload data — this is persisted and served. */
  code?: string;
}

/**
 * An intent's position in the lifecycle plus how it got there.
 *
 * Server-side this is the authority: the client's opinion about its own state
 * is a display concern, and a client claiming AUTHORIZED does not make it so.
 */
export class IntentLifecycle {
  private current: IntentState;
  private readonly log: TransitionRecord[] = [];

  constructor(
    readonly intentId: string,
    initial: IntentState = 'DRAFT',
    private readonly clock: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.current = initial;
  }

  get state(): IntentState {
    return this.current;
  }

  get history(): readonly TransitionRecord[] {
    return this.log;
  }

  get isTerminal(): boolean {
    return TERMINAL.has(this.current);
  }

  get isCancellable(): boolean {
    return CANCELLABLE.has(this.current) && canTransition(this.current, 'CANCELLED');
  }

  /** Whether an external liquidity provider may be contacted right now. The
   * adapters call this rather than checking a state name themselves, so the
   * rule lives in exactly one place. */
  get mayRequestQuote(): boolean {
    return this.current === 'REVEALED' || this.current === 'QUOTING';
  }

  /** True once this intent has passed every state required before a quote.
   * Used by the audit log rather than by the guard, which is graph-enforced. */
  hasPassed(state: IntentState): boolean {
    return this.log.some((r) => r.to === state);
  }

  to(next: IntentState, code?: string): TransitionRecord {
    assertTransition(this.current, next);
    const rec: TransitionRecord = { from: this.current, to: next, at: this.clock() };
    if (code !== undefined) rec.code = code;
    this.log.push(rec);
    this.current = next;
    return rec;
  }

  /** Replay a persisted history. Validates every edge on the way, so a
   * corrupted or hand-edited audit trail cannot be loaded and then trusted. */
  static fromHistory(intentId: string, records: readonly TransitionRecord[]): IntentLifecycle {
    const lc = new IntentLifecycle(intentId);
    for (const r of records) {
      if (r.from !== lc.current) {
        throw new Error(`history is not contiguous at ${r.from} -> ${r.to}: expected from=${lc.current}`);
      }
      assertTransition(r.from, r.to);
      lc.log.push(r);
      lc.current = r.to;
    }
    return lc;
  }
}
