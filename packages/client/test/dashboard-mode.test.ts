import { afterEach, expect, test } from 'bun:test';
import { ForbiddenError } from '../src/api/client.js';
import { toRuntimeSnapshot } from '../src/api/claude-box.js';
import { toModelSettings } from '../src/api/model.js';
import { DashboardPoll, initialDashboard, type DashboardSource } from '../src/api/dashboard-poll.js';
import { dashboardReadingStale } from '../src/api/dashboard.js';

const organization = { id: 'fixture-org', name: 'Fixture', slug: null, role: 'member' as const,
  agents: [{ id: 'fixture-agent', host: 'fixture.example.invalid', name: null, slug: null, avatar: null }] };
const MODE = { mode: 'local' as const, owner: organization.id, version: '0.1.0-beta.270', stopped: false };
const SESSION = toRuntimeSnapshot({ running: true, runner: 'cli' });
const MODEL = toModelSettings({ connections: [] });
const flush = async (): Promise<void> => { for (let at = 0; at < 60; at += 1) await Promise.resolve(); };
const polls: DashboardPoll[] = [];
afterEach(() => { for (const poll of polls.splice(0)) poll.stop(); });

function harness(overrides: Partial<DashboardSource> = {}) {
  let state = initialDashboard();
  const source: DashboardSource = {
    organizations: () => Promise.resolve([organization]), token: () => Promise.resolve('fixture-token'),
    mode: () => Promise.resolve(MODE), session: () => Promise.resolve(SESSION), model: () => Promise.resolve(MODEL),
    current: () => true, forgetToken: () => undefined, ...overrides,
  };
  const poll = new DashboardPoll(source, (next) => { state = next; });
  polls.push(poll);
  const cycle = async (): Promise<void> => { poll.stop(); poll.start(); await flush(); };
  return { poll, source, cycle, row: () => state.rows[0] };
}

test('public version is published before an unrelated organization token or private snapshot settles', async () => {
  const token = Promise.withResolvers<string>();
  const run = harness({ token: () => token.promise });
  await run.cycle();
  expect(run.row()?.mode).toMatchObject({ data: MODE, error: null });
  expect(run.row()?.session.data).toBeNull();
  token.reject(new Error('token unavailable')); await flush();
  expect(run.row()?.mode).toMatchObject({ data: MODE, error: null });
  expect(run.row()?.session).toMatchObject({ data: null, error: 'token unavailable' });
});

test('a mode failure retains only the dated version while other successful readings remain fresh', async () => {
  const run = harness(); await run.cycle();
  const at = run.row()?.mode.at;
  run.source.mode = () => Promise.reject(new Error('mode unavailable'));
  await run.cycle();
  const row = run.row();
  if (row === undefined) throw new Error('missing fixture');
  expect(row.mode).toMatchObject({ data: MODE, at, error: 'mode unavailable' });
  expect(dashboardReadingStale(row.mode, Date.now())).toBe(true);
  expect(row.session).toMatchObject({ data: SESSION, error: null });
});

test('mode owner refusal clears the old version and an inventory failure dates every retained reading', async () => {
  const run = harness(); await run.cycle();
  run.source.organizations = () => Promise.reject(new Error('inventory unavailable'));
  await run.cycle();
  expect(run.row()?.mode).toMatchObject({ data: MODE, error: 'inventory unavailable' });
  run.source.organizations = () => Promise.resolve([organization]);
  run.source.mode = () => Promise.reject(new ForbiddenError('owner changed'));
  await run.cycle();
  expect(run.row()?.mode).toMatchObject({ data: null, at: null, error: 'owner changed' });
});

test.each([false, true])('owner refusal clears private readings before a pending token settles and never restores them, token failure: %s', async (tokenFailure) => {
  const run = harness(); await run.cycle();
  const token = Promise.withResolvers<string>();
  run.source.token = () => token.promise;
  run.source.mode = () => Promise.reject(new ForbiddenError('owner changed'));
  await run.cycle();
  const cleared = { data: null, at: null, error: 'owner changed' };
  expect(run.row()).toMatchObject({ mode: cleared, session: cleared, model: cleared });
  if (tokenFailure) token.reject(new Error('token unavailable')); else token.resolve('fixture-token');
  await flush();
  expect(run.row()).toMatchObject({ mode: cleared, session: cleared, model: cleared });
});

test('late mode owner refusal clears already completed private readings', async () => {
  const run = harness(); await run.cycle();
  const mode = Promise.withResolvers<typeof MODE>();
  run.source.mode = () => mode.promise;
  await run.cycle();
  expect(run.row()?.session.data).toBe(SESSION);
  mode.reject(new ForbiddenError('owner changed')); await flush();
  const cleared = { data: null, at: null, error: 'owner changed' };
  expect(run.row()).toMatchObject({ mode: cleared, session: cleared, model: cleared });
});

test('membership removal and account changes do not publish a retained or late version', async () => {
  const run = harness(); await run.cycle();
  run.source.organizations = () => Promise.resolve([]);
  await run.cycle(); expect(run.row()).toBeUndefined();
  run.source.organizations = () => Promise.resolve([organization]);
  const mode = Promise.withResolvers<typeof MODE>();
  run.source.mode = () => mode.promise;
  await run.cycle();
  run.source.current = () => false;
  mode.resolve(MODE); await flush();
  expect(run.row()?.mode.data).toBeNull();
});
