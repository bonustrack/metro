import { describe, expect, test } from 'bun:test';
import { dashboardKey, dashboardModel, dashboardSession, emptyReading, type DashboardReading } from '../src/api/dashboard.js';
import { toRuntimeSnapshot, type RuntimeSnapshot } from '../src/api/claude-box.js';
import { toModelSettings } from '../src/api/model.js';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const report = (used: number | null, label = 'Weekly', at = NOW, resetAt: string | null = null) => ({
  at: new Date(at).toISOString(), windows: [{ label, used, resetAt, detail: null }], note: null, tally: null,
});
const connection = (id: string, account: string | null = `${id}@example.invalid`) => ({
  id, provider: 'codex', model: 'gpt-test', label: `Connection ${id}`, account, signedIn: true,
});
const settings = () => toModelSettings({
  route: 'a', connections: [connection('a'), connection('b')],
  fallbacks: [{ connection: 'b', model: 'gpt-test' }],
  chain: [{ connection: 'a', model: 'gpt-test', active: true }, { connection: 'b', model: 'gpt-test', active: false }],
  usage: { a: report(0.47), b: report(0), passthrough: report(1) },
});
const runtime = (runner: string | null = 'sdk', running = true, phase = 'working', updatedAt = NOW): RuntimeSnapshot => toRuntimeSnapshot({
  runner, running, activity: { runner: 'sdk', pid: 42, phase, updatedAt },
});
const reading = (data: RuntimeSnapshot, at: number | null = NOW): DashboardReading<RuntimeSnapshot> => ({
  data, at, error: null, unavailable: false,
});

describe('dashboard identity and model selection', () => {
  test('row keys distinguish organization, agent id and host, never display names', () => {
    const agent = { id: 'agent', host: 'one.example.invalid', name: 'Same name', slug: null, avatar: null };
    expect(new Set([
      dashboardKey('org-a', agent), dashboardKey('org-b', agent),
      dashboardKey('org-a', { ...agent, id: 'another' }), dashboardKey('org-a', { ...agent, host: 'two.example.invalid' }),
    ]).size).toBe(4);
    expect(dashboardKey('org-a', { ...agent, name: 'Renamed', slug: 'new' })).toBe(dashboardKey('org-a', agent));
  });

  test('same-model accounts keep the selected connection and its exact zero-capable usage', () => {
    const value = settings();
    expect(dashboardModel(value, NOW)).toMatchObject({
      model: 'gpt-test', connection: 'Connection a · a@example.invalid', usage: 'Weekly · 47% used', note: 'Primary route',
    });
    value.chain = value.chain.map((row) => ({ ...row, active: row.connection === 'b' }));
    expect(dashboardModel(value, NOW)).toMatchObject({
      model: 'gpt-test', connection: 'Connection b · b@example.invalid', usage: 'Weekly · 0% used', note: 'Current fallback route',
    });
  });

  test('an active fallback uses its chosen model, not the primary or connection default', () => {
    const value = toModelSettings({
      route: 'a', connections: [connection('a'), { ...connection('b'), provider: 'gemini', model: 'gemini-default' }],
      fallbacks: [{ connection: 'b', model: 'gemini-flash' }],
      chain: [{ connection: 'a', model: 'gpt-test', active: false }, { connection: 'b', model: 'gemini-flash', active: true }],
      usage: { a: report(0.98), b: { at: new Date(NOW).toISOString(), windows: [
        { label: 'gemini-default', used: 1 }, { label: 'gemini-flash', used: 0.12 }, { label: 'gemini-flash-plus', used: 0.99 },
      ] } },
    });
    expect(dashboardModel(value, NOW)).toMatchObject({ model: 'gemini-flash', usage: 'gemini-flash · 12% used', note: 'Current fallback route' });
  });

  test('a current held route reports the hold rather than silently presenting an inactive fallback', () => {
    const value = settings();
    const primary = value.chain[0];
    if (primary === undefined) throw new Error('missing primary');
    primary.hold = { reason: 'Weekly limit reached', until: null };
    expect(dashboardModel(value, NOW)).toMatchObject({ connection: 'Connection a · a@example.invalid', note: 'Weekly limit reached' });
    value.chain = [];
    expect(dashboardModel(value, NOW).connection).toBe('Connection a · a@example.invalid');
  });

  test('a missing connection cannot borrow passthrough usage, another account or the last served route', () => {
    const value = settings();
    value.connections = value.connections.filter((row) => row.id !== 'a');
    value.lastServed = { connection: 'b', provider: 'codex', model: 'gpt-elsewhere', at: new Date(NOW).toISOString() };
    expect(dashboardModel(value, NOW)).toEqual({ model: 'Model unavailable', connection: 'Connection unavailable', usage: 'Usage unavailable', report: null, note: null });
  });

  test('missing per-connection usage and identity do not inherit other account data', () => {
    const value = settings();
    value.connections = value.connections.map((row) => row.id === 'a' ? { ...row, account: null } : row);
    delete value.usage.a;
    const card = dashboardModel(value, NOW);
    expect(card.connection).toBe('Connection a');
    expect(card.usage).toContain('Usage unavailable');
    expect(card.report).toBeNull();
    expect(JSON.stringify(card)).not.toContain('b@example.invalid');
    expect(JSON.stringify(card)).not.toContain('100%');
  });

  test('only an explicit passthrough route uses the passthrough reading and served model', () => {
    const value = toModelSettings({ route: '', connections: [], usage: { passthrough: report(0.2) },
      lastServed: { connection: 'passthrough', provider: 'anthropic', model: 'claude-sonnet-test', at: new Date(NOW).toISOString() },
    });
    expect(dashboardModel(value, NOW)).toMatchObject({ model: 'claude-sonnet-test', connection: 'Claude Code login', usage: 'Weekly, all models · 20% used' });
    if (value.lastServed !== null) value.lastServed.connection = 'other-account';
    expect(dashboardModel(value, NOW).model).toBe('Model not reported');
  });

  test('model-scoped, expired and per-minute windows cannot inflate the selected model', () => {
    const value = toModelSettings({ route: 'a', connections: [{ ...connection('a'), provider: 'anthropic', model: 'claude-sonnet-test' }],
      usage: { a: { at: new Date(NOW).toISOString(), windows: [
        { label: 'Weekly, Opus', used: 1 }, { label: 'Weekly, Sonnet', used: 0.12 },
        { label: 'Weekly', used: 0.4 }, { label: 'Tokens per minute', used: 1 },
        { label: 'Session', used: 1, resetAt: new Date(NOW).toISOString() }, { label: 'Credits', used: null },
      ] } },
    });
    expect(dashboardModel(value, NOW).usage).toBe('Weekly, all models · 40% used');
  });

  test('zero, absent, unknown, stale and reset readings remain distinct', () => {
    const value = settings();
    value.usage.a = report(0);
    expect(dashboardModel(value, NOW).usage).toBe('Weekly · 0% used');
    value.usage.a = report(null);
    expect(dashboardModel(value, NOW).usage).toContain('Usage unavailable');
    value.usage.a = report(0.47, 'Weekly', NOW - 5 * 60_000);
    expect(dashboardModel(value, NOW)).toMatchObject({ usage: 'Weekly · 47% used', report: expect.stringContaining('May be out of date') });
    value.usage.a = report(0.99, 'Weekly', NOW - 60_000, new Date(NOW).toISOString());
    expect(dashboardModel(value, NOW).usage).toBe('Usage window reset. Waiting for a new reading.');
    delete value.usage.a;
    expect(dashboardModel(value, NOW)).toMatchObject({ usage: expect.stringContaining('Usage unavailable'), report: null });
  });
});

describe('dashboard observed runtime status', () => {
  test.each([
    ['starting', 'Starting'], ['idle', 'Idle'], ['working', 'Working'], ['approval', 'Waiting for approval'],
    ['compacting', 'Compacting'], ['error', 'Error'], ['stopped', 'Running'],
  ])('fresh SDK phase %s is %s', (phase, status) => {
    expect(dashboardSession(reading(runtime('sdk', true, phase)), NOW)).toMatchObject({ status, harness: 'Agent SDK', observed: expect.stringContaining('Checked') });
  });

  test('stale, future and absent SDK activity cannot pretend the process is working', () => {
    for (const at of [NOW - 30_001, NOW + 30_001]) {
      expect(dashboardSession(reading(runtime('sdk', true, 'working', at)), NOW)).toMatchObject({ status: 'Running · activity stale', harness: 'Agent SDK' });
    }
    expect(dashboardSession(reading({ ...runtime(), activity: null }), NOW).status).toBe('Running');
  });

  test('CLI and unknown runners never inherit SDK activity', () => {
    expect(dashboardSession(reading(runtime('cli')), NOW)).toMatchObject({ status: 'Running', harness: 'Claude Code' });
    expect(dashboardSession(reading(runtime('future-runner')), NOW)).toMatchObject({ status: 'Running', harness: 'Unknown' });
  });

  test('a stopped runtime does not present the configured SDK as observed running', () => {
    expect(dashboardSession(reading(runtime('sdk', false)), NOW)).toMatchObject({ status: 'Stopped', harness: 'Unknown' });
  });

  test('checking, unreachable and unsupported do not masquerade as stopped', () => {
    const empty = emptyReading<RuntimeSnapshot>();
    expect(dashboardSession(empty, NOW)).toEqual({ status: 'Checking…', harness: 'Unknown', observed: null });
    expect(dashboardSession({ ...empty, error: 'offline' }, NOW)).toEqual({ status: 'Unreachable', harness: 'Unknown', observed: 'offline' });
    expect(dashboardSession({ ...empty, unavailable: true, error: '404' }, NOW)).toMatchObject({ status: 'Status unavailable', observed: 'Update Metro to see runtime status.' });
  });

  test('old, future, undated or failed observations show unknown and preserve last-seen context', () => {
    for (const at of [NOW - 60_001, NOW + 1, null]) {
      expect(dashboardSession(reading(runtime('cli'), at), NOW)).toMatchObject({ status: 'Status unknown', harness: 'Claude Code (last seen)' });
    }
    expect(dashboardSession({ ...reading(runtime('sdk')), error: 'offline' }, NOW)).toMatchObject({
      status: 'Status unknown', harness: 'Agent SDK (last seen)', observed: expect.stringContaining('Agent did not answer'),
    });
    expect(dashboardSession(reading(runtime('cli'), NOW - 60_000), NOW).status).toBe('Running');
  });
});
