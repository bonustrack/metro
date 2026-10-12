import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createConnectorMigration, MIGRATION_UNCERTAIN } from '../src/api/connector-migration-flow.js';
import { MIGRATION_UPDATE } from '../src/api/connector-migration.js';
import { installTestAccount } from './account-fixture.js';
import { CENTRAL, LOCAL, SOURCE, SCOPE, migrationFixture, migrationRow, previewBody, sourceRow, statusBody } from './connector-migration-fixture.js';

let fixture: ReturnType<typeof migrationFixture>;
beforeEach(() => { fixture = migrationFixture(); });
afterEach(() => { fixture.close(); });
const posts = () => fixture.requests.filter((row) => row.init.method === 'POST');

describe('staged connector migration', () => {
  test('opening reads preview and status with admin bearer, but never mutates', async () => {
    const session = fixture.open();
    expect(fixture.requests).toHaveLength(0);
    const result = await session.refresh();
    expect(result.plan?.rows[0]?.source.policy).toEqual(sourceRow().policy);
    expect(result.status?.scope).toBe(SCOPE);
    expect(fixture.requests.map((row) => row.url)).toEqual([`${LOCAL}/migration-preview`, CENTRAL, `${LOCAL}/migrations`]);
    expect(posts()).toHaveLength(0);
    const status = fixture.requests.at(-1)?.init;
    expect(new Headers(status?.headers).get('authorization')).toStartWith('Bearer ');
    expect(status?.signal).toBeInstanceOf(AbortSignal);
    expect(status?.redirect).toBe('error');
  });

  test('prepare posts only the captured scope, source and action and never credentials or policy', async () => {
    const session = fixture.open();
    await session.refresh();
    const prepared = await session.act(SOURCE, 'prepare');
    expect(prepared.status?.migrations[0]?.phase).toBe('prepared');
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0]?.init.body))).toEqual({ scope: SCOPE, sourceId: SOURCE, action: 'prepare', operationId: null });
    expect(posts()[0]?.url).toBe(`${LOCAL}/migrations`);
    expect(posts()[0]?.init.redirect).toBe('error');
    expect(fixture.requests).toHaveLength(4);
  });

  test('fresh central signin is explicit and readiness still requires reconciliation', async () => {
    fixture.reply = statusBody([migrationRow('prepared', 'sign_in')]);
    const session = fixture.open();
    await session.refresh();
    await session.act(SOURCE, 'prepare');
    await expect(session.act(SOURCE, 'cutover')).rejects.toThrow('Reconcile');
    expect(posts()).toHaveLength(1);
    expect(await session.signIn(SOURCE)).toBe('https://calendar.example/authorize');
    expect(posts()[1]?.url).toBe(`${CENTRAL}/central0001/sign-in`);
    expect(session.snapshot().status?.migrations[0]?.reason).toBe('sign_in');
    fixture.reply = statusBody([migrationRow('prepared')]);
    await session.act(SOURCE, 'reconcile');
    fixture.reply = statusBody([migrationRow('cutover', 'waiting_for_local')]);
    expect((await session.act(SOURCE, 'cutover')).status?.migrations[0]?.phase).toBe('cutover');
    fixture.reply = statusBody([migrationRow('active')]);
    expect((await session.act(SOURCE, 'reconcile')).status?.migrations[0]?.phase).toBe('active');
    expect(posts().map((row) => JSON.parse(String(row.init.body)).action).filter(Boolean)).toEqual(['prepare', 'reconcile', 'cutover', 'reconcile']);
  });

  test('rollback is explicit, retains partial state, and a rolled-back source can be prepared again', async () => {
    fixture.status = statusBody([migrationRow('preparing', 'unavailable')]);
    const session = fixture.open();
    await session.refresh();
    fixture.reply = statusBody([migrationRow('rollback', 'assignment_changed')]);
    expect((await session.act(SOURCE, 'rollback')).status?.migrations[0]?.phase).toBe('rollback');
    fixture.reply = statusBody([migrationRow('rolled_back', 'sign_in')]);
    expect((await session.act(SOURCE, 'reconcile')).status?.migrations[0]?.phase).toBe('rolled_back');
    fixture.reply = statusBody([migrationRow('prepared', 'sign_in')]);
    await session.act(SOURCE, 'prepare');
    expect(posts().map((row) => JSON.parse(String(row.init.body)).action)).toEqual(['rollback', 'reconcile', 'prepare']);
    expect(posts().every((row) => row.url === `${LOCAL}/migrations`)).toBe(true);
  });

  test('interrupted writes stay uncertain with no automatic retry, Refresh alone cannot clear them', async () => {
    const session = fixture.open();
    await session.refresh();
    fixture.failPost = true;
    await expect(session.act(SOURCE, 'prepare')).rejects.toThrow(MIGRATION_UNCERTAIN);
    expect(session.snapshot().uncertain).toEqual([SOURCE]);
    expect(posts()).toHaveLength(1);
    await session.refresh();
    await expect(session.act(SOURCE, 'prepare')).rejects.toThrow(MIGRATION_UNCERTAIN);
    expect(posts()).toHaveLength(1);
    fixture.failPost = false;
    await session.act(SOURCE, 'reconcile');
    expect(session.snapshot().uncertain).toEqual([]);
    expect(posts()).toHaveLength(2);
    expect(JSON.parse(String(posts()[1]?.init.body)).action).toBe('reconcile');
  });

  test('explicit empty Reconcile clears an uncertain Prepare that never reached the agent', async () => {
    const session = fixture.open();
    await session.refresh();
    fixture.failPost = true;
    await expect(session.act(SOURCE, 'prepare')).rejects.toThrow(MIGRATION_UNCERTAIN);
    fixture.failPost = false;
    fixture.reply = statusBody();
    await session.refresh();
    const reconciled = await session.act(SOURCE, 'reconcile');
    expect(reconciled.status?.migrations).toEqual([]);
    expect(reconciled.uncertain).toEqual([]);
    expect(posts()).toHaveLength(2);
    fixture.reply = statusBody([migrationRow()]);
    await session.act(SOURCE, 'prepare');
    expect(posts().map((row) => JSON.parse(String(row.init.body)).action)).toEqual(['prepare', 'reconcile', 'prepare']);
  });

  test('a timed-out POST is uncertain, aborts its transport and is never retried', async () => {
    const session = fixture.open();
    await session.refresh();
    const serve = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const response = await serve(input, init);
      if (init.method !== 'POST') return response;
      return new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (signal?.aborted) reject(new Error('timed out'));
        else signal?.addEventListener('abort', () => { reject(new Error('timed out')); }, { once: true });
      });
    }, { preconnect: serve.preconnect });
    const schedule = globalThis.setTimeout;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((handler, timeout, ...args) => schedule(handler, timeout === 30_000 ? 1 : timeout, ...args));
    try {
      await expect(session.act(SOURCE, 'prepare')).rejects.toThrow(MIGRATION_UNCERTAIN);
      expect(posts()).toHaveLength(1);
      expect(posts()[0]?.init.signal?.aborted).toBe(true);
      expect(session.snapshot().uncertain).toEqual([SOURCE]);
    } finally {
      timer.mockRestore();
    }
  });

  test('failed Refresh keeps partial progress and its exact source policy but blocks further actions', async () => {
    const session = fixture.open();
    await session.refresh();
    await session.act(SOURCE, 'prepare');
    fixture.previewCode = 503;
    fixture.preview = { error: 'fixture-private-url-and-token' };
    fixture.failStatus = true;
    const result = await session.refresh();
    expect(result.status?.migrations[0]?.phase).toBe('prepared');
    expect(result.plan?.rows[0]?.source.policy).toEqual(sourceRow().policy);
    expect(result.previewError).toContain('Last confirmed');
    expect(result.statusError).toContain('Last confirmed');
    expect(JSON.stringify(result)).not.toContain('fixture-private');
    await expect(session.act(SOURCE, 'cutover')).rejects.toThrow('Refresh');
    expect(posts()).toHaveLength(1);
  });

  test('an old preview capability and a missing status endpoint are explicit update paths', async () => {
    fixture.preview = { ...previewBody(), migrationSupported: false };
    fixture.statusCode = 404;
    fixture.status = { error: 'fixture-secret-not-found' };
    const session = fixture.open();
    expect((await session.refresh()).statusError).toBe(MIGRATION_UPDATE);
    await expect(session.act(SOURCE, 'prepare')).rejects.toThrow(MIGRATION_UPDATE);
    expect(posts()).toHaveLength(0);
  });

  test('a missing capability alone blocks POST even if a status response exists', async () => {
    fixture.preview = { ...previewBody(), migrationSupported: undefined };
    const session = fixture.open();
    await session.refresh();
    await expect(session.act(SOURCE, 'prepare')).rejects.toThrow(MIGRATION_UPDATE);
    expect(posts()).toHaveLength(0);
  });

  test('members and signed-out callers send no migration reads or writes', async () => {
    installTestAccount({ role: 'member' });
    const session = fixture.open();
    await expect(session.refresh()).rejects.toThrow('Only an organization admin');
    await expect(session.act(SOURCE, 'prepare')).rejects.toThrow('Only an organization admin');
    expect(fixture.requests).toHaveLength(0);
    fixture.close();
    const signedOut = createConnectorMigration();
    try { await expect(signedOut.refresh()).rejects.toThrow('changed'); } finally { signedOut.dispose(); }
  });

  test('disabled sync, unenrolled agents and unsupported sources cannot prepare', async () => {
    for (const flags of [{ enabled: false }, { enrolled: false }]) {
      fixture.status = { ...statusBody(), ...flags };
      const session = fixture.open();
      await session.refresh();
      await expect(session.act(SOURCE, 'prepare')).rejects.toThrow('sync and enrollment');
    }
    fixture.status = statusBody();
    for (const issue of ['unsupported_url', 'unused_oauth_client', 'oauth_private_resource', 'invalid_config', 'custom_policy']) {
      fixture.preview = { ...previewBody(), connectors: [{ ...sourceRow(), issues: [issue] }] };
      const session = fixture.open();
      await session.refresh();
      await expect(session.act(SOURCE, 'prepare')).rejects.toThrow('source blockers');
    }
    expect(posts()).toHaveLength(0);
  });

  test('recovery stays available with sync off, but preparation and cutover do not', async () => {
    fixture.preview = { ...previewBody(), enabled: false, connectors: [] };
    fixture.status = { ...statusBody([migrationRow('cutover', 'sync_unavailable')]), enabled: false };
    const session = fixture.open();
    await session.refresh();
    fixture.reply = { ...statusBody([migrationRow('cutover', 'sync_unavailable')]), enabled: false };
    await session.act(SOURCE, 'reconcile');
    await expect(session.act(SOURCE, 'cutover')).rejects.toThrow('sync and enrollment');
    fixture.reply = { ...statusBody([migrationRow('rolled_back')]), enabled: false };
    expect((await session.act(SOURCE, 'rollback')).status?.migrations[0]?.phase).toBe('rolled_back');
    expect(posts().map((row) => JSON.parse(String(row.init.body)).action)).toEqual(['reconcile', 'rollback']);
  });

  test('unknown reason codes become a generic blocker, and extra response secrets are excluded', async () => {
    fixture.status = { ...statusBody([{ ...migrationRow('prepared', 'fixture-private-error'), clientSecret: 'fixture-secret' }]), credentials: 'fixture-token' };
    const session = fixture.open();
    const result = await session.refresh();
    expect(result.status?.migrations[0]?.reason).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('fixture-');
    await expect(session.act(SOURCE, 'cutover')).rejects.toThrow('Reconcile');
    expect(posts()).toHaveLength(0);
  });

  test('malformed scopes and partial replies never become successful activation', async () => {
    for (const scope of ['', 'wrong', 'a'.repeat(63), 'g'.repeat(64)]) {
      fixture.status = { ...statusBody(), scope };
      const session = fixture.open();
      expect((await session.refresh()).statusError).not.toBeNull();
      await expect(session.act(SOURCE, 'prepare')).rejects.toThrow('Refresh');
    }
    fixture.status = statusBody();
    const session = fixture.open();
    await session.refresh();
    fixture.reply = statusBody();
    await expect(session.act(SOURCE, 'prepare')).rejects.toThrow(MIGRATION_UNCERTAIN);
    expect(session.snapshot().status?.migrations).toEqual([]);
    expect(session.snapshot().uncertain).toEqual([SOURCE]);
  });

  test('401 POST replies do not silently retry a migration', async () => {
    const session = fixture.open();
    await session.refresh();
    fixture.postCode = 401;
    fixture.reply = { error: 'not authorized' };
    await expect(session.act(SOURCE, 'prepare')).rejects.toThrow(MIGRATION_UNCERTAIN);
    expect(posts()).toHaveLength(1);
  });
});
