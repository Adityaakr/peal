import { describe, expect, it } from 'vitest';
import {
  CANCELLABLE,
  IntentLifecycle,
  InvalidTransition,
  REQUIRED_BEFORE_QUOTING,
  STATES,
  TERMINAL,
  canTransition,
  nextStates,
  type IntentState,
} from '../src/state.js';

/** Every simple path from DRAFT to `target`. The graph is tiny and acyclic
 * enough that full enumeration is instant, which is what makes the privacy
 * property below a proof over the graph rather than a spot check. */
function allPathsTo(target: IntentState): IntentState[][] {
  const paths: IntentState[][] = [];
  const walk = (at: IntentState, seen: IntentState[]) => {
    if (at === target) {
      paths.push([...seen, at]);
      return;
    }
    for (const nxt of nextStates(at)) {
      if (seen.includes(nxt)) continue; // no cycles
      walk(nxt, [...seen, at]);
    }
  };
  walk('DRAFT', []);
  return paths;
}

describe('the privacy property', () => {
  // This is the test that matters. Peal's product claim is that no liquidity
  // provider learns anything before ordering is locked; if an edge is ever
  // added that lets an intent reach QUOTING early, this fails.
  it('cannot reach QUOTING without committing ordering and revealing first', () => {
    const paths = allPathsTo('QUOTING');
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      for (const required of REQUIRED_BEFORE_QUOTING) {
        expect(path, `path ${path.join(' -> ')} skipped ${required}`).toContain(required);
      }
      // Ordering must lock BEFORE the reveal, not merely appear somewhere.
      expect(path.indexOf('ORDER_COMMITTED')).toBeLessThan(path.indexOf('REVEALED'));
      expect(path.indexOf('REVEALED')).toBeLessThan(path.indexOf('QUOTING'));
    }
  });

  it('holds for every downstream execution state too', () => {
    for (const target of ['QUOTE_VALIDATED', 'AUTHORIZED', 'SUBMITTED_FOR_EXECUTION', 'SETTLED'] as const) {
      for (const path of allPathsTo(target)) {
        expect(path, `${target} via ${path.join(' -> ')}`).toContain('ORDER_COMMITTED');
        expect(path).toContain('REVEALED');
      }
    }
  });

  it('only permits a quote request while revealed or already quoting', () => {
    for (const s of STATES) {
      const lc = new IntentLifecycle('i', s);
      expect(lc.mayRequestQuote, `${s}`).toBe(s === 'REVEALED' || s === 'QUOTING');
    }
  });
});

describe('graph shape', () => {
  it('terminal states have no outgoing edges', () => {
    for (const s of TERMINAL) expect(nextStates(s)).toEqual([]);
  });

  it('every non-terminal state can still reach a terminal state', () => {
    // Guards against a state that traps an intent forever with no way to fail,
    // expire, or settle out of it.
    const reaches = (from: IntentState): boolean => {
      const seen = new Set<IntentState>();
      const stack: IntentState[] = [from];
      while (stack.length) {
        const at = stack.pop()!;
        if (TERMINAL.has(at)) return true;
        if (seen.has(at)) continue;
        seen.add(at);
        stack.push(...nextStates(at));
      }
      return false;
    };
    for (const s of STATES) expect(reaches(s), `${s} is a trap`).toBe(true);
  });

  it('every state is reachable from DRAFT', () => {
    const seen = new Set<IntentState>(['DRAFT']);
    const stack: IntentState[] = ['DRAFT'];
    while (stack.length) {
      for (const n of nextStates(stack.pop()!)) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    for (const s of STATES) expect(seen.has(s), `${s} is unreachable`).toBe(true);
  });
});

describe('cancellation', () => {
  it('is impossible once the batch owns the intent', () => {
    // Pulling a ciphertext out of a committed batch is the reordering power the
    // commitment exists to remove, so these states must refuse it.
    for (const s of ['BATCHED', 'ORDER_COMMITTED', 'COLLECTING_SHARES', 'THRESHOLD_REACHED'] as const) {
      expect(canTransition(s, 'CANCELLED'), `${s} must not be cancellable`).toBe(false);
      expect(CANCELLABLE.has(s)).toBe(false);
    }
  });

  it('is impossible once the transaction has been handed to a submitter', () => {
    for (const s of ['SUBMITTED_FOR_EXECUTION', 'CONFIRMED'] as const) {
      expect(canTransition(s, 'CANCELLED')).toBe(false);
    }
  });

  it('is available while the agent still holds the decision', () => {
    for (const s of ['REVEALED', 'QUOTE_VALIDATED', 'AUTHORIZATION_REQUIRED', 'AUTHORIZED'] as const) {
      expect(new IntentLifecycle('i', s).isCancellable).toBe(true);
    }
  });
});

describe('IntentLifecycle', () => {
  const clock = () => 1_700_000_000;

  it('walks the happy path and records every step', () => {
    const lc = new IntentLifecycle('i', 'DRAFT', clock);
    const path: IntentState[] = [
      'SEALED', 'SUBMITTED', 'VALIDATED', 'BATCHED', 'ORDER_COMMITTED',
      'COLLECTING_SHARES', 'THRESHOLD_REACHED', 'REVEALED', 'QUOTING',
      'QUOTE_VALIDATED', 'AUTHORIZATION_REQUIRED', 'AUTHORIZED',
      'SUBMITTED_FOR_EXECUTION', 'CONFIRMED', 'SETTLED',
    ];
    for (const s of path) lc.to(s);
    expect(lc.state).toBe('SETTLED');
    expect(lc.isTerminal).toBe(true);
    expect(lc.history).toHaveLength(path.length);
    expect(lc.history.every((r) => r.at === 1_700_000_000)).toBe(true);
    expect(lc.hasPassed('ORDER_COMMITTED')).toBe(true);
  });

  it('refuses an illegal jump', () => {
    const lc = new IntentLifecycle('i', 'SUBMITTED');
    expect(() => lc.to('QUOTING')).toThrow(InvalidTransition);
    // and leaves the state untouched
    expect(lc.state).toBe('SUBMITTED');
  });

  it('refuses to leave a terminal state', () => {
    const lc = new IntentLifecycle('i', 'SETTLED');
    expect(() => lc.to('FAILED')).toThrow(InvalidTransition);
  });

  it('keeps a failure code without inventing one', () => {
    const lc = new IntentLifecycle('i', 'REVEALED', clock);
    lc.to('QUOTING');
    lc.to('FAILED', 'NO_LIQUIDITY');
    expect(lc.history.at(-1)).toEqual({ from: 'QUOTING', to: 'FAILED', at: 1_700_000_000, code: 'NO_LIQUIDITY' });
    // An ordinary transition carries no code at all rather than an empty one,
    // so "has a code" stays a meaningful signal.
    expect(lc.history[0]).toEqual({ from: 'REVEALED', to: 'QUOTING', at: 1_700_000_000 });
    expect('code' in lc.history[0]!).toBe(false);
  });

  it('replays a persisted history', () => {
    const lc = new IntentLifecycle('i', 'DRAFT', clock);
    lc.to('SEALED');
    lc.to('SUBMITTED');
    const replayed = IntentLifecycle.fromHistory('i', lc.history);
    expect(replayed.state).toBe('SUBMITTED');
    expect(replayed.history).toEqual(lc.history);
  });

  it('rejects a tampered history', () => {
    // A hand-edited audit trail that claims a state it never legally reached
    // must not load, or everything downstream trusts a lie.
    expect(() =>
      IntentLifecycle.fromHistory('i', [
        { from: 'DRAFT', to: 'SEALED', at: 1 },
        { from: 'SEALED', to: 'REVEALED', at: 2 },
      ]),
    ).toThrow(InvalidTransition);
  });

  it('rejects a non-contiguous history', () => {
    expect(() =>
      IntentLifecycle.fromHistory('i', [
        { from: 'DRAFT', to: 'SEALED', at: 1 },
        { from: 'VALIDATED', to: 'BATCHED', at: 2 },
      ]),
    ).toThrow(/not contiguous/);
  });
});
