import { describe, expect, test } from 'bun:test';
import { toClaudeSession } from '@metro-labs/client/api/claude-box';
import { freshness, sdkEntries, sessionView } from '../src/components/run/session.js';
import { clock, sameTimeRange, stamp } from '../src/components/run/model.js';
import { eventBuckets } from '../src/components/run/filters.js';

const now = 100_000;
const status = (extra: Record<string, unknown> = {}) => toClaudeSession({
  running: true, runner: 'sdk', activity: {
    runner: 'sdk', pid: 123, phase: 'working', mainPhase: 'idle', updatedAt: now,
    mainStartedAt: null, sessionId: '11111111-2222-4333-8444-555555555555', workers: 1,
    tasks: [{ id: 'worker-one', status: 'running', startedAt: 10_000, updatedAt: 99_000, agent: 'Explore', background: true }],
    activeTools: [{ id: 'tool-one', name: 'Read', taskId: 'worker-one', startedAt: 90_000 }],
    events: [{ id: 'event-one', at: 90_000, kind: 'tool_started', tool: 'Read', toolUseId: 'tool-one', taskId: 'worker-one' }],
  }, ...extra,
});

describe('Run session semantics', () => {
  test('main remains idle when a worker is running', () => {
    const session = status();
    expect(freshness(session, now, false)).toBe('Fresh');
    const view = sessionView(session, now, false);
    expect(view?.main).toBe('Main agent: idle');
    expect(view?.workers).toHaveLength(1);
    expect(view?.tools).toBe('Main tools: None reported');
    expect(sdkEntries(session, now, false)[0]?.worker).toBe('worker-one');
  });

  test('stale and disconnected timers freeze at the last report', () => {
    const session = status();
    expect(freshness(session, now + 30_001, false)).toBe('Stale');
    expect(freshness(session, now - 30_001, false)).toBe('Stale');
    expect(freshness(session, now + 30_000, false)).toBe('Fresh');
    const stale = sessionView(session, now + 40_000, false);
    const disconnected = sessionView(session, now + 90_000, true);
    expect(stale?.workers[0]?.summary).toContain('running (1 min 30 s) at the last report');
    expect(disconnected?.workers[0]?.summary).toContain('running (1 min 30 s) at the last report');
    expect(freshness(session, now, true)).toBe('Disconnected');
    expect(sdkEntries(session, now, true)[0]?.status).toBe('Last observed');
  });

  test('old and stopped daemons do not acquire a live SDK claim', () => {
    expect(freshness(status({ runner: 'cli' }), now, false)).toBe('Unsupported');
    expect(freshness(status({ running: false }), now, false)).toBe('Stopped');
    expect(freshness(toClaudeSession({ running: true }), now, false)).toBe('Unsupported');
    expect(freshness(status({ activity: null }), now, false)).toBe('Waiting for status');
    expect(freshness(undefined, now, false)).toBe('Loading');
  });

  test('active failures remain current and a cleared flag alone proves no recovery', () => {
    const failure = { id: 'failure-one', at: 95_000, kind: 'turn_failed', code: 'provider_error', taskId: null };
    const base = status();
    const active = toClaudeSession({ ...base, activity: { ...base.activity, activeFailure: failure, lastFailure: failure, events: [failure] } });
    expect(sdkEntries(active, now, false)[0]?.status).toBe('Failed');
    expect(sdkEntries(active, now, true)[0]?.status).toBe('Failed at last report');
    const cleared = toClaudeSession({ ...base, activity: { ...base.activity, activeFailure: null, lastFailure: failure, events: [failure] } });
    expect(sdkEntries(cleared, now, false)[0]?.status).toBe('Past error');
    expect(sdkEntries(cleared, now, false)[0]?.text).not.toContain('no longer marks');
    const historical = toClaudeSession({ ...base, activity: { ...base.activity, events: [failure] } });
    expect(sdkEntries(historical, now, false)[0]?.status).toBe('Past error');
  });

  test.each([
    ['tool_failed', 'read_token_limit'], ['task_failed', 'task_error'], ['compact_failed', 'compact_error'],
  ])('a fresh %s is not resolved by a null active failure or a successful main turn', (kind, code) => {
    const failure = { id: 'failure-one', at: 95_000, kind, code, taskId: kind === 'task_failed' ? 'worker-one' : null };
    const finished = { id: 'finished', at: 98_000, kind: 'turn_finished', taskId: null };
    const base = status();
    for (const events of [[failure], [finished, failure]]) {
      const session = toClaudeSession({ ...base, activity: { ...base.activity, activeFailure: null, lastFailure: failure, events } });
      const row = sdkEntries(session, now, false).find((entry) => entry.kind === 'Error');
      expect(freshness(session, now, false)).toBe('Fresh');
      expect(row?.status).toBe('Past error');
      expect(row?.text).not.toContain('successfully');
    }
  });

  test('a later successful main turn is explicit recovery evidence for a main turn failure', () => {
    const failure = { id: 'failure-one', at: 95_000, kind: 'turn_failed', code: 'provider_error', taskId: null };
    const finished = { id: 'finished', at: 98_000, kind: 'turn_finished', taskId: null };
    const base = status();
    const session = toClaudeSession({ ...base, activity: { ...base.activity, activeFailure: null, lastFailure: failure, events: [finished, failure] } });
    const row = sdkEntries(session, now, false).find((entry) => entry.kind === 'Error');
    expect(row?.status).toBe('Resolved');
    expect(row?.text).toContain('A later main turn completed successfully in this session.');
    expect(sdkEntries(session, now + 40_000, true).find((entry) => entry.kind === 'Error')?.status).toBe('Resolved');
  });

  test('a restarted turn, older success or worker success cannot prove main recovery', () => {
    const failure = { id: 'failure-one', at: 95_000, kind: 'turn_failed', code: 'provider_error', taskId: null };
    const base = status();
    for (const event of [
      { at: 98_000, kind: 'turn_started', taskId: null },
      { at: 94_000, kind: 'turn_finished', taskId: null },
      { at: 95_000, kind: 'turn_finished', taskId: null },
      { at: 98_000, kind: 'turn_finished', taskId: 'worker-one' },
      { at: 98_000, kind: 'turn_finished', toolUseId: 'worker-tool', taskId: null },
    ]) {
      const session = toClaudeSession({ ...base, activity: { ...base.activity, activeFailure: null, lastFailure: failure, events: [event, failure] } });
      expect(sdkEntries(session, now, false).find((entry) => entry.kind === 'Error')?.status).toBe('Past error');
    }
  });

  test('unassigned SDK tools are not attributed to the main agent', () => {
    const base = status();
    const session = toClaudeSession({ ...base, activity: { ...base.activity, events: [{ at: 90_000, kind: 'tool_started', tool: 'Bash', taskId: null }] } });
    expect(sdkEntries(session, now, false)[0]?.worker).toBe('Unlinked');
    expect(sdkEntries(session, now, false)[0]?.sender).toBe('SDK session');
  });
});

const legacyEntries = (events: unknown[]) => {
  const base = status();
  return sdkEntries(toClaudeSession({ ...base, activity: { ...base.activity, events } }), now, false);
};

describe('Run SDK event identity', () => {
  const first = { at: 90_000, kind: 'tool_started', tool: 'Read', taskId: 'worker-one' };
  const next = { at: 95_000, kind: 'tool_started', tool: 'Bash', taskId: null };

  test('legacy event identity survives a prepend and older-event eviction', () => {
    const initial = legacyEntries([first]);
    const prepended = legacyEntries([next, first]);
    expect(prepended[1]?.id).toBe(initial[0]?.id);
    expect(legacyEntries([next])[0]?.id).toBe(prepended[0]?.id);
  });

  test('same-time legacy events use their safe tool and task fields, not array position', () => {
    const events = [first, { ...first, tool: 'Write' }, { ...first, taskId: 'worker-two' }, { ...first, toolUseId: 'call-one' }];
    const initial = legacyEntries(events).map((row) => row.id);
    expect(new Set(initial).size).toBe(events.length);
    expect(legacyEntries(events.toReversed()).map((row) => row.id)).toEqual(initial.toReversed());
  });

  test('indistinguishable legacy duplicates keep unique keys across prepends', () => {
    const initial = legacyEntries([first, first]).map((row) => row.id);
    const prepended = legacyEntries([first, first, first]).map((row) => row.id);
    expect(new Set(prepended).size).toBe(3);
    expect(prepended.slice(1)).toEqual(initial);
  });

  test('legacy IDs are safe and scoped to the reported process when session ID is absent', () => {
    const base = status();
    const entryFor = (procStart: string) => sdkEntries(toClaudeSession({
      ...base, activity: { ...base.activity, sessionId: null, procStart, events: [first] },
    }), now, false)[0];
    expect(entryFor('100')?.id).toMatch(/^[A-Za-z0-9_.%~-]+$/);
    expect(entryFor('100')?.id).not.toBe(entryFor('200')?.id);
  });
});

describe('Run timestamp formatting', () => {
  test('timestamps the SDK parser accepts outside Date range cannot crash formatting', () => {
    const entries = legacyEntries([{ at: Number.MAX_SAFE_INTEGER, kind: 'turn_started', taskId: null }]);
    expect(entries[0]?.at).toBe(Number.MAX_SAFE_INTEGER);
    expect(stamp(entries[0]!.at)).toBe('Invalid time');
    expect(clock(entries[0]!.at)).toBe('Invalid time');
    for (const at of [8_640_000_000_000_001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(stamp(at)).toBe('Invalid time');
      expect(clock(at)).toBe('Invalid time');
    }
  });

  test('valid UTC dates preserve their format, including the supported boundary', () => {
    expect(stamp(90_000)).toBe('1970-01-01 00:01:30 UTC');
    expect(clock(90_000)).toBe('00:01:30');
    expect(stamp(8_640_000_000_000_000)).toBe('+275760-09-13 00:00:00 UTC');
    expect(clock(8_640_000_000_000_000)).toBe('00:00:00');
  });
});

describe('Run chart interval selection', () => {
  test('a rebinned bar with the same start and a larger end is not the selected interval', () => {
    const original = legacyEntries([{ at: 1_000, kind: 'turn_started', taskId: null }]);
    const selected = eventBuckets(original)[0]!;
    const updated = legacyEntries([
      { at: 1_500_000, kind: 'turn_started', taskId: null },
      { at: 90_000, kind: 'turn_started', taskId: null },
      { at: 1_000, kind: 'turn_started', taskId: null },
    ]);
    const enlarged = eventBuckets(updated)[0]!;
    expect(enlarged.start).toBe(selected.start);
    expect(enlarged.end).toBeGreaterThan(selected.end);
    expect(sameTimeRange(selected, enlarged)).toBe(false);
    expect(sameTimeRange(enlarged, enlarged)).toBe(true);
  });

  test('new counts in the same full interval preserve selection', () => {
    const selected = { start: 0, end: 60_000, count: 1 };
    const updated = { ...selected, count: 2 };
    expect(sameTimeRange(selected, updated)).toBe(true);
    expect(sameTimeRange(null, updated)).toBe(false);
    expect(sameTimeRange({ ...selected, start: 1 }, updated)).toBe(false);
  });
});
