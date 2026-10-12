import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setCurrentServer } from '../src/auth/daemon.js';
import { configurePlatform, location } from '../src/platform.js';
import { MIGRATION_CHANGED } from '../src/api/connector-migration-identity.js';
import { installTestAccount } from './account-fixture.js';
import { AGENT, CENTRAL, LOCAL, SOURCE, migrationFixture, migrationRow, statusBody } from './connector-migration-fixture.js';

let fixture: ReturnType<typeof migrationFixture>;
const originalLocation = location();
beforeEach(() => { fixture = migrationFixture(); });
afterEach(() => { fixture.close(); configurePlatform({ location: originalLocation }); });

const leaveAndReturn = () => {
  setCurrentServer({ id: 'other000001', host: 'other.example' });
  setCurrentServer({ id: AGENT, host: 'source.example' });
};

describe('migration captured identity', () => {
  test('an agent switch away and back invalidates the whole dialog, not only one read', async () => {
    let invalidated = 0;
    const session = fixture.open(() => { invalidated += 1; });
    await session.refresh();
    leaveAndReturn();
    await expect(session.refresh()).rejects.toThrow(MIGRATION_CHANGED);
    await expect(session.act(SOURCE, 'prepare')).rejects.toThrow(MIGRATION_CHANGED);
    expect(() => session.snapshot()).toThrow(MIGRATION_CHANGED);
    expect(invalidated).toBe(1);
    expect(fixture.requests).toHaveLength(3);
  });

  test('an account switch away and back invalidates captured writes', async () => {
    const session = fixture.open();
    await session.refresh();
    installTestAccount({ org_id: 'org_other' });
    installTestAccount();
    await expect(session.act(SOURCE, 'prepare')).rejects.toThrow(MIGRATION_CHANGED);
    expect(fixture.requests).toHaveLength(3);
  });

  test('changing a server host or routed daemon base rejects before another request', async () => {
    const session = fixture.open();
    await session.refresh();
    setCurrentServer({ id: AGENT, host: 'other.example' });
    await expect(session.act(SOURCE, 'prepare')).rejects.toThrow(MIGRATION_CHANGED);
    setCurrentServer({ id: AGENT, host: 'source.example' });
    const next = fixture.open();
    await next.refresh();
    configurePlatform({ location: { ...originalLocation, hash: () => '#/other.example/connectors' } });
    await expect(next.act(SOURCE, 'prepare')).rejects.toThrow(MIGRATION_CHANGED);
    expect(fixture.requests.filter((row) => row.init.method === 'POST')).toHaveLength(0);
  });

  test('a switch during a POST aborts its request and does not publish the response', async () => {
    const session = fixture.open();
    await session.refresh();
    fixture.afterFetch = (url, init) => { if (url === `${LOCAL}/migrations` && init.method === 'POST') leaveAndReturn(); };
    await expect(session.act(SOURCE, 'prepare')).rejects.toThrow(MIGRATION_CHANGED);
    const post = fixture.requests.at(-1);
    expect(post?.init.method).toBe('POST');
    expect(post?.init.signal?.aborted).toBe(true);
    expect(() => session.snapshot()).toThrow(MIGRATION_CHANGED);
    expect(fixture.requests).toHaveLength(4);
  });

  test('a switch during preview stops the central metadata read and status fetch', async () => {
    const session = fixture.open();
    fixture.afterFetch = () => { leaveAndReturn(); };
    await expect(session.refresh()).rejects.toThrow(MIGRATION_CHANGED);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.init.signal?.aborted).toBe(true);
  });

  test('central signin checks the captured agent before sending and after its reply', async () => {
    fixture.status = statusBody([migrationRow('prepared', 'sign_in')]);
    const session = fixture.open();
    await session.refresh();
    const signin = session.signIn(SOURCE);
    leaveAndReturn();
    await expect(signin).rejects.toThrow(MIGRATION_CHANGED);
    expect(fixture.requests.some((row) => row.url.endsWith('/sign-in'))).toBe(false);
    const next = fixture.open();
    await next.refresh();
    fixture.afterFetch = (url) => { if (url === `${CENTRAL}/central0001/sign-in`) leaveAndReturn(); };
    await expect(next.signIn(SOURCE)).rejects.toThrow(MIGRATION_CHANGED);
    expect(fixture.requests.at(-1)?.init.signal?.aborted).toBe(true);
  });

  test('changed owner, agent and opaque server scope fail closed, even in a successful reply', async () => {
    for (const changes of [{ owner: 'org_other' }, { agentId: 'other000001' }, { scope: 'b'.repeat(64) }]) {
      const session = fixture.open();
      await session.refresh();
      fixture.reply = { ...statusBody([migrationRow()]), ...changes };
      await expect(session.act(SOURCE, 'prepare')).rejects.toThrow(MIGRATION_CHANGED);
      await expect(session.refresh()).rejects.toThrow(MIGRATION_CHANGED);
    }
  });

  test('scope changes on Refresh invalidate instead of quietly adopting a new destination', async () => {
    const session = fixture.open();
    await session.refresh();
    fixture.status = { ...statusBody(), scope: 'b'.repeat(64) };
    await expect(session.refresh()).rejects.toThrow(MIGRATION_CHANGED);
    expect(() => session.snapshot()).toThrow(MIGRATION_CHANGED);
  });

  test('closing a dialog permanently blocks a delayed action', async () => {
    const session = fixture.open();
    await session.refresh();
    session.dispose();
    await expect(session.act(SOURCE, 'prepare')).rejects.toThrow(MIGRATION_CHANGED);
    expect(fixture.requests).toHaveLength(3);
  });
});
