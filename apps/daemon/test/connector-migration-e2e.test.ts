import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { connectorAgents, connectorMigrations, connectors } from '../../api/src/db/schema.js';
import { destinationId, LOCAL_KEY, MIGRATIONS, migrationE2E, SOURCE, TEST_DATABASE_URL, UNMIGRATED, type MigrationE2E, type Variant } from './migration-e2e-fixture.js';
import { ACCESS, GOOD_KEY, REFRESH } from '../../api/test/org-connectors-fixture.js';
import { LOCAL_ACCESS, LOCAL_REFRESH, MANUAL_SECRET, POLICY, URL_SECRET } from './migration-e2e-vendor.js';
import { within } from './org-sync-control-fixture.js';

let fixture: MigrationE2E | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

const secretFree = (text: string) => {
  for (const value of [GOOD_KEY, URL_SECRET, LOCAL_ACCESS, LOCAL_REFRESH, MANUAL_SECRET, ACCESS, REFRESH]) expect(text).not.toContain(value);
};

async function policyCalls(f: MigrationE2E) {
  const before = f.vendor.calls.length;
  expect((await f.tool('read_item')).status).toBe(200);
  expect((await f.tool('exception')).status).toBe(200);
  expect(await (await f.tool('write_item')).text()).toContain("Blocked by the owner's policy");
  expect(await (await f.tool('special')).text()).toContain('approval');
  expect(await (await f.tool('unknown_tool')).text()).toContain("Blocked by the owner's policy");
  expect(f.vendor.calls.slice(before).map((call) => call.tool)).toEqual(['read_item', 'exception']);
}

describe.skipIf(TEST_DATABASE_URL === undefined)('migration from real daemon admin HTTP through signed API and PostgreSQL', () => {
  test('admin authentication and stale scopes gate writes before any signed API request', async () => {
    const f = fixture = await migrationE2E();
    const scope = (await f.status()).scope;
    for (const [authorization, status] of [['', 401], ['Bearer malformed', 401], [`Bearer ${LOCAL_KEY}`, 401], [f.member, 403], [f.stranger, 403]] as const) {
      expect((await f.request(MIGRATIONS, 'GET', undefined, authorization)).status).toBe(status);
      expect((await f.request(MIGRATIONS, 'POST', { sourceId: SOURCE, action: 'prepare', scope }, authorization)).status).toBe(status);
    }
    expect((await f.action('prepare')).status).toBe(409);
    expect((await f.setSync(true)).liveEnabled).toBe(false);
    expect((await f.action('prepare', '0'.repeat(64))).status).toBe(409);
    expect((await f.request(MIGRATIONS, 'POST', { sourceId: SOURCE, action: 'prepare', scope, value: 'browser-secret' })).status).toBe(400);
    expect(await f.held.db1.$count(connectorMigrations)).toBe(0);
    expect(f.traffic.filter((row) => row.path.endsWith('/connector-migrations'))).toEqual([]);
  });

  for (const variant of ['none', 'query', 'header'] as const satisfies readonly Variant[]) {
    test(`${variant} preserves encrypted configuration and exact policy through the original runtime alias with LIVE=false`, async () => {
      const f = fixture = await migrationE2E(variant);
      const local = readFileSync(join(f.dir, 'connectors.json'), 'utf8');
      const plugin = f.plugins()['migration-fixture'];
      await policyCalls(f);
      await f.setSync(true);
      const prepared = await f.move('prepare');
      expect(prepared).toMatchObject({ phase: 'prepared', reason: null });
      const id = destinationId(prepared);
      expect(await f.held.db1.$count(connectors)).toBe(1);
      expect(await f.held.db1.$count(connectorAgents)).toBe(0);
      const { row, secret } = await f.destination(id);
      expect(row.url).toBe('https://vendor.example');
      expect(row.secret).toStartWith('v1.');
      expect(JSON.parse(row.policy ?? '{}')).toEqual(POLICY);
      expect(secret?.targetUrl).toBe(f.source.url);
      expect(secret?.kind).toBe(variant === 'header' ? 'header' : 'none');
      if (secret?.kind === 'header') expect(secret.value).toBe(GOOD_KEY);
      secretFree(JSON.stringify(await (await f.request(MIGRATIONS)).json()));
      secretFree(JSON.stringify({ rows: await f.held.db1.select().from(connectors), migrations: await f.held.db1.select().from(connectorMigrations) }));
      secretFree(JSON.stringify(f.traffic));
      expect((await f.move('cutover')).phase).toBe('active');
      expect(await f.held.db1.$count(connectorAgents)).toBe(1);
      expect(f.plugins()['migration-fixture']).toEqual(plugin);
      expect(Object.values(f.plugins()).some((server) => server.url.endsWith(`/relay/org-${id}`))).toBe(false);
      expect(readFileSync(join(f.dir, 'connectors.json'), 'utf8')).toBe(local);
      expect(statSync(join(f.dir, 'connector-migrations.json')).mode & 0o777).toBe(0o600);
      secretFree(readFileSync(join(f.dir, 'connector-migrations.json'), 'utf8'));
      await policyCalls(f);
      expect((await f.tool('read_item', UNMIGRATED)).status).toBe(200);
      expect((await f.tool('read_item', `org-${id}`)).status).toBe(404);
      expect(f.traffic.some((row) => row.path.endsWith('/connectors') && row.response.includes('sealed'))).toBe(true);
      expect(f.traffic.every((row) => row.authorization.startsWith('MetroAgent '))).toBe(true);
      expect((await f.move('rollback')).phase).toBe('rolled_back');
      expect(await f.held.db1.$count(connectorAgents)).toBe(0);
      expect(await f.held.db1.$count(connectors)).toBe(1);
      expect(f.plugins()['migration-fixture']).toEqual(plugin);
      await policyCalls(f);
    });
  }

  for (const variant of ['oauth-manual', 'oauth-dynamic'] as const) {
    test(`${variant} uses fresh central sign-in and rollback removes old local tokens instead of reviving them`, async () => {
      const f = fixture = await migrationE2E(variant);
      expect((await f.tool()).status).toBe(200);
      expect(f.vendor.calls.at(-1)?.authorization).toBe(`Bearer ${LOCAL_ACCESS}`);
      await f.setSync(true);
      const prepared = await f.move('prepare');
      const id = destinationId(prepared);
      expect(prepared).toMatchObject({ phase: 'prepared', reason: 'sign_in' });
      const initial = (await f.destination(id)).secret;
      if (initial?.kind !== 'oauth') throw new Error('missing OAuth secret');
      expect(initial.tokens).toBeUndefined();
      expect(initial.client.clientId).toBe(variant === 'oauth-manual' ? 'fixture-manual-client' : 'client-1');
      if (variant === 'oauth-manual') expect(initial.client.clientSecret).toBe(MANUAL_SECRET);
      expect(f.vendor.oauth.registrations).toBe(variant === 'oauth-manual' ? 0 : 1);
      expect((await f.move('cutover')).phase).toBe('prepared');
      expect(await f.held.db1.$count(connectorAgents)).toBe(0);
      await f.completeOAuth(id);
      expect(f.vendor.oauth.tokenCalls).toBe(1);
      expect((await f.move('cutover')).phase).toBe('active');
      await policyCalls(f);
      expect(f.vendor.calls.at(-1)?.authorization).toBe(`Bearer ${ACCESS}`);
      secretFree(JSON.stringify(f.traffic));
      expect(await f.move('rollback')).toMatchObject({ phase: 'rolled_back', reason: 'sign_in' });
      expect(await f.held.db1.$count(connectorAgents)).toBe(0);
      const local = readFileSync(join(f.dir, 'connectors.json'), 'utf8');
      expect(local).not.toContain(LOCAL_ACCESS); expect(local).not.toContain(LOCAL_REFRESH);
      const before = f.vendor.calls.length;
      expect((await f.tool()).status).toBe(424);
      expect(f.vendor.calls.length).toBe(before);
      expect(await f.held.db1.$count(connectors)).toBe(1);
      const central = (await f.destination(id)).secret;
      if (central?.kind !== 'oauth') throw new Error('missing retained OAuth secret');
      expect(central.tokens?.accessToken).toBe(ACCESS);
    });
  }

  test('cutover and rollback durably fence new calls while existing vendor streams drain', async () => {
    const f = fixture = await migrationE2E();
    await f.setSync(true); await f.move('prepare');
    const local = await f.tool('hold'); const localText = local.text(); await within(f.vendor.held());
    expect(await f.move('cutover')).toMatchObject({ phase: 'cutover', reason: 'waiting_for_local' });
    expect(await f.held.db1.$count(connectorAgents)).toBe(0);
    expect((await f.tool()).status).toBe(409);
    f.vendor.release(); expect(await within(localText)).toContain('completed');
    expect((await f.move('reconcile')).phase).toBe('active');
    const org = await f.tool('hold'); const orgText = org.text(); await within(f.vendor.held());
    expect(await f.move('rollback')).toMatchObject({ phase: 'rollback', reason: 'waiting_for_local' });
    expect(await f.held.db1.$count(connectorAgents)).toBe(1);
    expect((await f.tool()).status).toBe(409);
    f.vendor.release(); expect(await within(orgText)).toContain('completed');
    expect((await f.move('reconcile')).phase).toBe('rolled_back');
    expect(await f.held.db1.$count(connectorAgents)).toBe(0);
    expect((await f.tool()).status).toBe(200);
    expect(f.vendor.calls.map((call) => call.tool)).toEqual(['hold', 'hold', 'read_item']);
  });
});
