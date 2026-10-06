import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { OrganizationRow } from '../src/api/auth.js';
import { AuthError, ForbiddenError, NotFoundError, StoppedError } from '../src/api/client.js';
import { toRuntimeSnapshot, type RuntimeSnapshot } from '../src/api/claude-box.js';
import { DashboardPoll, initialDashboard, type DashboardSource } from '../src/api/dashboard-poll.js';
import { dashboardSession, type DashboardState } from '../src/api/dashboard.js';
import { toModelSettings, type ModelSettings } from '../src/api/model.js';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const SESSION = toRuntimeSnapshot({ running: true, runner: 'cli' });
const MODEL = toModelSettings({ route: '', connections: [] });
const organization = (id: string, ids = ['one']): OrganizationRow => ({
  id, name: id, slug: id, role: 'member', agents: ids.map((agent) => ({ id: agent, host: `${agent}.example.invalid`, name: 'Same name', slug: null, avatar: null })),
});
const realTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const timerHost: {
  setTimeout: (callback: () => void, ms?: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer?: ReturnType<typeof setTimeout>) => void;
} = globalThis;
const timers = new Map<ReturnType<typeof setTimeout>, { run: () => void; ms: number | undefined }>();
let restoreTimers = (): void => undefined;
let polls: DashboardPoll[] = [];
let now = NOW;
const flush = async (): Promise<void> => { for (let at = 0; at < 60; at += 1) await Promise.resolve(); };

beforeEach(() => {
  now = NOW;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const schedule = spyOn(timerHost, 'setTimeout').mockImplementation((callback, ms) => {
    const timer = realTimeout(() => undefined, 2 ** 30);
    timer.unref();
    timers.set(timer, { run: () => callback(), ms });
    return timer;
  });
  const cancel = spyOn(timerHost, 'clearTimeout').mockImplementation((timer) => {
    if (timer !== undefined && typeof timer !== 'number') timers.delete(timer);
    realClearTimeout(timer);
  });
  restoreTimers = () => { schedule.mockRestore(); cancel.mockRestore(); clock.mockRestore(); };
});
afterEach(() => {
  for (const poll of polls) poll.stop();
  polls = [];
  for (const timer of timers.keys()) realClearTimeout(timer);
  timers.clear();
  restoreTimers();
});

function harness(overrides: Partial<DashboardSource> = {}) {
  const published: DashboardState[] = [];
  const source: DashboardSource = {
    organizations: mock(() => Promise.resolve([organization('org-a')])),
    token: mock((id: string) => Promise.resolve(`token:${id}`)),
    mode: mock((row) => Promise.resolve({ mode: 'local', owner: row.organization.id, version: '0.1.0-beta.271', stopped: false })),
    session: mock(() => Promise.resolve(SESSION)), model: mock(() => Promise.resolve(MODEL)),
    current: () => true, forgetToken: mock(() => undefined), ...overrides,
  };
  const poll = new DashboardPoll(source, (state) => published.push(state));
  polls.push(poll);
  const latest = (): DashboardState => {
    const state = published.at(-1);
    if (state === undefined) throw new Error('No dashboard state published');
    return state;
  };
  return { poll, source, published, latest };
}

function fireTimer(ms: number): void {
  expect(timers.size).toBe(1);
  const timer = timers.entries().next().value;
  if (timer === undefined) throw new Error('No scheduled timer');
  expect(timer[1].ms).toBe(ms);
  timers.delete(timer[0]);
  realClearTimeout(timer[0]);
  timer[1].run();
}
const nextPoll = (): void => fireTimer(30_000);

describe('dashboard polling controller', () => {
  test('starts with explicit unknown data and repeated start is single-flight', async () => {
    expect(initialDashboard()).toEqual({ organizations: null, rows: [], loading: true, refreshing: false, error: null });
    const listing = Promise.withResolvers<OrganizationRow[]>();
    const run = harness({ organizations: mock(() => listing.promise) });
    run.poll.start(); run.poll.start(); run.poll.start();
    await flush();
    expect(run.source.organizations).toHaveBeenCalledTimes(1);
    expect(run.latest()).toMatchObject({ loading: true, refreshing: true, rows: [] });
    expect(timers.size).toBe(0);
    listing.resolve([organization('org-a')]);
    await flush();
    expect(run.latest()).toMatchObject({ loading: false, refreshing: false, error: null });
    expect(timers.size).toBe(1);
    nextPoll();
    run.poll.start();
    await flush();
    expect(run.source.organizations).toHaveBeenCalledTimes(2);
    expect(timers.size).toBe(1);
  });

  test('endpoint and row failures leave successful siblings visible', async () => {
    const run = harness({
      organizations: () => Promise.resolve([organization('org-a', ['one', 'two']), organization('org-b', ['three'])]),
      session: (row) => row.agent.id === 'one' ? Promise.reject(new Error('session offline')) : Promise.resolve(SESSION),
      model: (row) => row.agent.id === 'two' ? Promise.reject(new NotFoundError('update first')) : Promise.resolve(MODEL),
    });
    run.poll.start(); await flush();
    const [one, two, three] = run.latest().rows;
    expect(one?.session).toMatchObject({ data: null, error: 'session offline', unavailable: false });
    expect(one?.model).toMatchObject({ data: MODEL, at: NOW, error: null });
    expect(two?.session.data).toBe(SESSION);
    expect(two?.model).toMatchObject({ data: null, at: null, error: 'update first', unavailable: true });
    expect(three).toMatchObject({ session: { data: SESSION }, model: { data: MODEL } });
    expect(run.source.token).toHaveBeenCalledTimes(2);
    expect(run.source.forgetToken).not.toHaveBeenCalled();
  });

  test('at most three rows and two endpoints per row run, with one token per organization per cycle', async () => {
    const calls: { row: string; endpoint: string; bearer: string; resolve: () => void }[] = [];
    const active = new Map<string, number>();
    let endpoints = 0;
    let maxEndpoints = 0;
    let maxRows = 0;
    const pending = <T>(id: string, endpoint: string, bearer: string, value: T): Promise<T> => {
      const deferred = Promise.withResolvers<T>();
      active.set(id, (active.get(id) ?? 0) + 1);
      endpoints += 1; maxEndpoints = Math.max(maxEndpoints, endpoints); maxRows = Math.max(maxRows, active.size);
      calls.push({ row: id, endpoint, bearer, resolve: () => {
        const left = (active.get(id) ?? 1) - 1;
        if (left === 0) active.delete(id); else active.set(id, left);
        endpoints -= 1; deferred.resolve(value);
      } });
      return deferred.promise;
    };
    const run = harness({ organizations: () => Promise.resolve([organization('org-a', ['one', 'two', 'three', 'four', 'five'])]),
      session: (row, bearer) => pending(row.key, 'session', bearer, SESSION), model: (row, bearer) => pending(row.key, 'model', bearer, MODEL),
    });
    run.poll.start(); await flush();
    expect(calls).toHaveLength(6);
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([20_000]);
    calls[0]?.resolve(); await flush();
    expect(calls).toHaveLength(6);
    calls[1]?.resolve(); await flush();
    expect(calls).toHaveLength(8);
    for (const call of calls.slice(2)) call.resolve();
    await flush();
    for (const call of calls.slice(8)) call.resolve();
    await flush();
    expect(calls).toHaveLength(10);
    expect(maxRows).toBe(3); expect(maxEndpoints).toBe(6); expect(endpoints).toBe(0);
    expect(calls.every((call) => call.bearer === 'token:org-a')).toBe(true);
    expect(new Set(calls.map((call) => `${call.row}:${call.endpoint}`)).size).toBe(10);
    expect(run.source.token).toHaveBeenCalledTimes(1);
    expect(run.latest().refreshing).toBe(false);
    expect(timers.size).toBe(1);
  });

  test('the enrichment deadline keeps prior readings and schedules without aborting the parent cycle', async () => {
    const run = harness(); run.poll.start(); await flush();
    const pending = Promise.withResolvers<ModelSettings>();
    const children: AbortSignal[] = []; const parents: AbortSignal[] = [];
    run.source.organizations = (signal) => { parents.push(signal); return Promise.resolve([organization('org-a')]); };
    run.source.model = (_row, _token, signal) => {
      children.push(signal);
      signal.addEventListener('abort', () => pending.reject(new Error('cancelled')), { once: true });
      return pending.promise;
    };
    nextPoll(); await flush(); fireTimer(20_000); await flush();
    expect(children[0]?.aborted).toBe(true); expect(parents[0]?.aborted).toBe(false);
    expect(run.latest().rows[0]).toMatchObject({ session: { data: SESSION, at: NOW, error: null }, model: { data: MODEL, at: NOW, error: null } });
    expect(run.latest().refreshing).toBe(false);
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([30_000]);
  });

  test.each([false, true])('thirty offline rows rotate and a discovered healthy row refreshes within fifty seconds, mode only: %s', async (modeOnly) => {
    const offline = Array.from({ length: 30 }, (_, index) => `offline-${index}`);
    const attempts: string[] = []; const parents: AbortSignal[] = []; const children: AbortSignal[] = [];
    let healthyReads = 0;
    const read = <T>(id: string, signal: AbortSignal, value: T): Promise<T> => {
      if (id === 'healthy') return Promise.resolve(value);
      children.push(signal);
      return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('offline')), { once: true }); });
    };
    const run = harness({
      organizations: (signal) => { parents.push(signal); return Promise.resolve([organization('org-a', [...offline, 'healthy'])]); },
      mode: (row, signal) => {
        if (row.agent.id === 'healthy') healthyReads += 1;
        return read(row.agent.id, signal, { mode: 'local', owner: row.organization.id, version: modeOnly ? '0.1.0-beta.270' : '0.1.0-beta.271', stopped: false });
      },
      session: (row, _token, signal) => {
        if (row.agent.id !== 'healthy') attempts.push(row.agent.id);
        return modeOnly && row.agent.id === 'healthy' ? Promise.reject(new NotFoundError('update first')) : read(row.agent.id, signal, SESSION);
      },
      model: (row, _token, signal) => modeOnly && row.agent.id === 'healthy' ? Promise.reject(new NotFoundError('update first')) : read(row.agent.id, signal, MODEL),
    });
    run.poll.start();
    let previous: number | null = null;
    for (let cycle = 0; cycle < 13; cycle += 1) {
      if (cycle > 0) { now += 30_000; nextPoll(); }
      await flush();
      const healthy = run.latest().rows.find((row) => row.agent.id === 'healthy');
      if (healthy === undefined) throw new Error('missing healthy row');
      if (previous !== null) { expect(now - previous).toBeLessThanOrEqual(50_000); expect(healthy.mode.at).toBe(now); }
      previous = healthy.mode.at;
      const observed = now;
      now += 20_000; fireTimer(20_000); await flush();
      expect(children.every((signal) => signal.aborted)).toBe(true);
      expect(parents.every((signal) => !signal.aborted)).toBe(true);
      expect(run.latest().refreshing).toBe(false);
      if (previous !== null) {
        expect(healthy.mode).toMatchObject({ at: observed, error: null });
        expect(healthy.session.data).toBe(modeOnly ? null : SESSION);
      }
    }
    expect(attempts.slice(0, 30)).toEqual(offline);
    expect(healthyReads).toBe(3);
    expect(run.latest().rows.filter((row) => row.agent.id !== 'healthy').every((row) => row.session.data === null && row.model.data === null)).toBe(true);
    expect(run.source.token).toHaveBeenCalledTimes(13);
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([30_000]);
  });

  test('transient endpoint and token errors retain their dated observation, but 404 clears only its endpoint', async () => {
    const run = harness(); run.poll.start(); await flush();
    run.source.session = () => Promise.reject(new Error('offline'));
    run.source.model = () => Promise.reject(new NotFoundError('unsupported'));
    nextPoll(); await flush();
    expect(run.latest().rows[0]?.session).toEqual({ data: SESSION, at: NOW, error: 'offline', unavailable: false });
    expect(run.latest().rows[0]?.model).toEqual({ data: null, at: null, error: 'unsupported', unavailable: true });
    run.source.token = () => Promise.reject(new Error('token service offline'));
    nextPoll(); await flush();
    expect(run.latest().rows[0]?.session).toMatchObject({ data: SESSION, at: NOW, error: 'token service offline' });
    expect(run.source.forgetToken).toHaveBeenCalledWith('org-a');
  });

  test.each([new AuthError('expired'), new ForbiddenError('membership removed')])('authorization refusal clears both endpoint snapshots: %s', async (error) => {
    const run = harness({ organizations: () => Promise.resolve([organization('org-a', ['one', 'two'])]) });
    run.poll.start(); await flush();
    run.source.model = (row) => row.agent.id === 'one' ? Promise.reject(error) : Promise.resolve(MODEL);
    nextPoll(); await flush();
    expect(run.latest().rows[0]?.session).toMatchObject({ data: null, at: null, error: error.message });
    expect(run.latest().rows[0]?.model).toMatchObject({ data: null, at: null, error: error.message });
    expect(run.latest().rows[1]).toMatchObject({ session: { data: SESSION }, model: { data: MODEL } });
    expect(run.source.forgetToken).toHaveBeenCalledWith('org-a');
  });

  test('organization listing failures mark retained rows stale, while auth clears the whole inventory', async () => {
    const run = harness(); run.poll.start(); await flush();
    run.source.organizations = () => Promise.reject(new Error('listing offline'));
    nextPoll(); await flush();
    expect(run.latest()).toMatchObject({ loading: false, refreshing: false, error: 'listing offline' });
    expect(run.latest().rows[0]?.session).toMatchObject({ data: SESSION, at: NOW, error: 'listing offline' });
    run.source.organizations = () => Promise.reject(new ForbiddenError('removed'));
    nextPoll(); await flush();
    expect(run.latest()).toEqual({ organizations: null, rows: [], loading: false, refreshing: false, error: 'removed' });
  });

  test('removed memberships are pruned and a new host or organization cannot reuse old readings', async () => {
    const run = harness(); run.poll.start(); await flush();
    const moved = organization('org-a');
    if (moved.agents?.[0] === undefined) throw new Error('missing agent');
    moved.agents[0].host = 'replacement.example.invalid';
    run.source.organizations = () => Promise.resolve([moved, organization('org-b')]);
    run.source.session = () => Promise.reject(new Error('new box offline'));
    run.source.model = () => Promise.reject(new Error('new model offline'));
    nextPoll(); await flush();
    expect(run.latest().rows).toHaveLength(2);
    expect(run.latest().rows.every((row) => row.session.data === null && row.model.data === null)).toBe(true);
    run.source.organizations = () => Promise.resolve([organization('org-b')]);
    nextPoll(); await flush();
    expect(run.latest().rows.map((row) => row.organization.id)).toEqual(['org-b']);
    run.source.organizations = () => Promise.resolve([]);
    nextPoll(); await flush();
    expect(run.latest()).toMatchObject({ organizations: [], rows: [], loading: false });
  });

  test('one organization token failure cannot block another organization or borrow its token', async () => {
    const requested: string[] = [];
    const run = harness({ organizations: () => Promise.resolve([organization('org-a'), organization('org-b')]),
      token: (id) => id === 'org-a' ? Promise.reject(new ForbiddenError('removed')) : Promise.resolve('token-b'),
      session: (row, token) => { requested.push(`${row.organization.id}:${token}`); return Promise.resolve(SESSION); },
      model: (row, token) => { requested.push(`${row.organization.id}:${token}`); return Promise.resolve(MODEL); },
    });
    run.poll.start(); await flush();
    expect(requested).toEqual(['org-b:token-b', 'org-b:token-b']);
    expect(run.latest().rows[0]).toMatchObject({ session: { data: null, error: 'removed' }, model: { data: null, error: 'removed' } });
    expect(run.latest().rows[1]).toMatchObject({ session: { data: SESSION }, model: { data: MODEL } });
  });

  test('a confirmed stopped daemon supersedes a previously running observation', async () => {
    const run = harness(); run.poll.start(); await flush();
    run.source.session = () => Promise.reject(new StoppedError('Metro is stopped.'));
    run.source.model = () => Promise.reject(new StoppedError('Metro is stopped.'));
    nextPoll(); await flush();
    const stopped = run.latest().rows[0];
    if (stopped === undefined) throw new Error('missing row');
    expect(dashboardSession(stopped.session, NOW).status).toBe('Metro stopped');
  });

  test('an unreported agents list remains different from a confirmed empty organization', async () => {
    const listed = [{ ...organization('unknown'), agents: null }, organization('empty', [])];
    const run = harness({ organizations: () => Promise.resolve(listed) });
    run.poll.start(); await flush();
    expect(run.latest().organizations?.map((org) => org.agents)).toEqual([null, []]);
    expect(run.latest().rows).toEqual([]);
    expect(run.source.token).not.toHaveBeenCalled();
  });

  test('stop aborts active requests and ignores successful late responses without another timer', async () => {
    const session = Promise.withResolvers<RuntimeSnapshot>();
    const model = Promise.withResolvers<ModelSettings>();
    const signals: AbortSignal[] = [];
    const run = harness({ session: (_row, _token, signal) => { signals.push(signal); return session.promise; },
      model: (_row, _token, signal) => { signals.push(signal); return model.promise; } });
    run.poll.start(); await flush();
    expect(signals).toHaveLength(2);
    run.poll.stop();
    const count = run.published.length;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    session.resolve(SESSION); model.resolve(MODEL); await flush();
    expect(run.published).toHaveLength(count);
    expect(timers.size).toBe(0);
  });

  test('scope changes suppress late endpoint and inventory results even before cleanup', async () => {
    let current = true;
    const model = Promise.withResolvers<ModelSettings>();
    const run = harness({ current: () => current, model: () => model.promise });
    run.poll.start(); await flush();
    current = false;
    const count = run.published.length;
    model.resolve(MODEL); await flush();
    expect(run.published).toHaveLength(count);
    expect(timers.size).toBe(0);
    const listing = Promise.withResolvers<OrganizationRow[]>();
    current = true;
    const second = harness({ current: () => current, organizations: () => listing.promise });
    second.poll.start(); current = false;
    listing.resolve([organization('org-a')]); await flush();
    expect(second.published).toHaveLength(1);
    expect(second.source.token).not.toHaveBeenCalled();
  });

  test('native-shaped signals without throwIfAborted can poll and stop', async () => {
    const original = globalThis.AbortController;
    globalThis.AbortController = class extends original {
      constructor() { super(); Object.defineProperty(this.signal, 'throwIfAborted', { value: undefined }); }
    };
    const run = harness();
    try {
      run.poll.start(); await flush();
      expect(run.latest()).toMatchObject({ loading: false, refreshing: false, error: null });
      expect(run.latest().rows[0]).toMatchObject({ session: { data: SESSION }, model: { data: MODEL } });
      const pending = Promise.withResolvers<ModelSettings>();
      const signals: AbortSignal[] = [];
      run.source.model = (_row, _token, bounded) => { signals.push(bounded); return pending.promise; };
      nextPoll(); await flush();
      expect(signals).toHaveLength(1);
      expect(signals[0]?.throwIfAborted).toBeUndefined();
      run.poll.stop(); const count = run.published.length;
      expect(signals[0]?.aborted).toBe(true);
      pending.resolve(MODEL); await flush();
      expect(run.published).toHaveLength(count);
    } finally {
      run.poll.stop();
      globalThis.AbortController = original;
    }
  });

  test('a stopped old cycle cannot overwrite or clear a restarted cycle controller', async () => {
    const old = Promise.withResolvers<ModelSettings>();
    const fresh = Promise.withResolvers<ModelSettings>();
    const signals: AbortSignal[] = [];
    const run = harness({ model: (_row, _token, signal) => { signals.push(signal); return signals.length === 1 ? old.promise : fresh.promise; } });
    run.poll.start(); await flush(); run.poll.stop(); run.poll.start(); await flush();
    const count = run.published.length;
    old.resolve(MODEL); await flush();
    expect(run.published).toHaveLength(count);
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([20_000]);
    run.poll.stop();
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    fresh.resolve(MODEL); await flush();
    expect(run.published).toHaveLength(count);
    expect(timers.size).toBe(0);
  });
});
