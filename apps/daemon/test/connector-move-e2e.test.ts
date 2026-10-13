import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectorAgents, connectorMigrations, connectors } from '../../api/src/db/schema.js';
import { ACCESS, REFRESH } from '../../api/test/org-connectors-fixture.js';
import { localMigrationEnabled, migrationExportableRows } from '../src/connectors/migration-guard.js';
import { freshOrgConnectors } from '../src/connectors/org-sync-watch.js';
import { readLocalConnectors } from '../src/connectors/store.js';
import { destinationId, migrationE2E, SOURCE, TEST_DATABASE_URL, UNMIGRATED, type MigrationE2E } from './migration-e2e-fixture.js';
import { LOCAL_ACCESS, LOCAL_REFRESH, MANUAL_SECRET, POLICY, VENDOR } from './migration-e2e-vendor.js';

let fixture: MigrationE2E | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

async function frozen(f: MigrationE2E): Promise<void> {
  for (let n = 0; n < 100; n += 1) {
    if (!localMigrationEnabled(SOURCE, f.dir)) return;
    await Bun.sleep(10);
  }
  throw new Error('source was not durably frozen');
}

async function privateState(f: MigrationE2E): Promise<void> {
  const text = JSON.stringify({ status: await f.status(), rows: await f.held.db1.select().from(connectors), mappings: await f.held.db1.select().from(connectorMigrations), traffic: f.traffic });
  for (const token of [LOCAL_ACCESS, LOCAL_REFRESH, MANUAL_SECRET, ACCESS, REFRESH]) expect(text).not.toContain(token);
  expect(migrationExportableRows(readLocalConnectors(f.dir), f.dir).map((row) => row.id)).toEqual([UNMIGRATED]);
}

describe.skipIf(TEST_DATABASE_URL === undefined)('automatic Move with real daemon, signed API and disposable PostgreSQL', () => {
  for (const variant of ['none', 'query', 'header', 'oauth-manual', 'oauth-dynamic'] as const) {
    test(`${variant} automatically verifies delivery and preserves identity, policy and actual grant`, async () => {
      const f = fixture = await migrationE2E(variant, (source) => {
        if (variant === 'oauth-manual' && source.config.auth.kind === 'oauth') source.config.auth.clientSecret = MANUAL_SECRET;
      });
      await f.setSync(true);
      const local = readFileSync(join(f.dir, 'connectors.json'), 'utf8');
      const plugin = f.plugins()['migration-fixture'];
      const result = await f.move('move');
      expect(result).toMatchObject({ phase: 'active', reason: null, move: true });
      const id = destinationId(result);
      const { row, secret } = await f.destination(id);
      expect(row.name).toBe(f.source.name);
      expect(JSON.parse(row.policy ?? '{}')).toEqual(POLICY);
      expect(secret?.targetUrl).toBe(f.source.url);
      if (secret?.kind === 'oauth') {
        expect(result.grantImported).toBe(true);
        expect(secret.client.clientId).toBe('old-local-registration');
        expect(secret.client.clientSecret).toBe(variant === 'oauth-manual' ? MANUAL_SECRET : undefined);
        expect(secret.tokens?.accessToken).toBe(LOCAL_ACCESS);
        expect(secret.tokens?.refreshToken).toBe(LOCAL_REFRESH);
        expect(secret.imported?.state).toBe('owned');
        expect((await f.action('rollback')).status).toBe(409);
      }
      expect(f.vendor.oauth.registrations).toBe(0);
      expect(f.vendor.oauth.tokenCalls).toBe(0);
      const assignments = await f.held.db1.select().from(connectorAgents);
      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.agent).toBe(f.agent.row.agent);
      expect(assignments[0]?.policy).toBeNull();
      expect(f.plugins()['migration-fixture']).toEqual(plugin);
      expect((await f.tool()).status).toBe(200);
      expect((await f.tool('exception')).status).toBe(200);
      expect(await (await f.tool('write_item')).text()).toContain("Blocked by the owner's policy");
      expect(await (await f.tool('special')).text()).toContain('approval');
      expect((await f.tool('read_item', UNMIGRATED)).status).toBe(200);
      expect((await f.move('move')).id).toBe(result.id);
      expect(await f.held.db1.$count(connectors)).toBe(1);
      expect(readFileSync(join(f.dir, 'connectors.json'), 'utf8')).toBe(local);
      await privateState(f);
    });
  }

  test('expired grant refreshes centrally with its original binding and scope, never locally', async () => {
    const f = fixture = await migrationE2E('oauth-dynamic', (source) => {
      if (source.config.auth.kind !== 'oauth') throw new Error('OAuth expected');
      source.config.auth = { ...source.config.auth, refreshToken: REFRESH, scope: 'read original', resource: `${VENDOR}/mcp`, expiresAt: 1 };
    });
    await f.setSync(true);
    const result = await f.move('move');
    expect(result.phase).toBe('active');
    expect(f.vendor.oauth.tokenCalls).toBe(1);
    expect(Object.fromEntries(f.vendor.oauth.tokenForms[0] ?? [])).toMatchObject({ grant_type: 'refresh_token', refresh_token: REFRESH, client_id: 'old-local-registration', scope: 'read original', resource: `${VENDOR}/mcp` });
    expect(readLocalConnectors(f.dir)[0]?.config.auth).toMatchObject({ accessToken: LOCAL_ACCESS, expiresAt: 1 });
    await f.restart();
    expect((await f.move('move')).phase).toBe('active');
    await freshOrgConnectors();
    expect((await f.tool()).status).toBe(200);
    expect(f.vendor.calls.at(-1)?.authorization).toBe(`Bearer ${ACCESS}`);
    expect(f.vendor.oauth.tokenCalls).toBe(1);
  });

  test('durable freeze precedes capture and drains an existing local stream', async () => {
    const f = fixture = await migrationE2E('oauth-dynamic');
    await f.setSync(true);
    const response = await f.tool('hold');
    const body = response.text();
    await f.vendor.held();
    const pending = f.move('move');
    await frozen(f);
    expect(await f.held.db1.$count(connectors)).toBe(0);
    expect((await f.tool()).status).toBe(409);
    f.vendor.release();
    await body;
    expect((await pending).phase).toBe('active');
  });

  for (const drop of ['begin', 'handover', 'activate']) {
    test(`lost ${drop} reply resumes after restart without duplicate grant or destination`, async () => {
      const f = fixture = await migrationE2E('oauth-dynamic');
      await f.setSync(true);
      f.faults.drop = drop;
      expect((await f.action('move')).status).toBe(503);
      expect(localMigrationEnabled(SOURCE, f.dir)).toBe(false);
      await f.restart();
      expect((await f.move('move')).phase).toBe('active');
      expect(await f.held.db1.$count(connectors)).toBe(1);
      expect(await f.held.db1.$count(connectorAgents)).toBe(1);
      expect(f.vendor.oauth.registrations).toBe(0);
      expect(f.vendor.oauth.tokenCalls).toBe(0);
    });
  }

  test('fresh delivery failure keeps source stopped and finishes forward on retry', async () => {
    const f = fixture = await migrationE2E('oauth-dynamic');
    await f.setSync(true);
    f.faults.badDelivery = true;
    expect((await f.action('move')).status).toBe(503);
    expect(localMigrationEnabled(SOURCE, f.dir)).toBe(false);
    expect((await f.action('rollback')).status).toBe(409);
    f.faults.badDelivery = false;
    await f.restart();
    expect((await f.move('move')).phase).toBe('active');
  });

  test('reuses a pristine legacy destination, but never overwrites known central credentials', async () => {
    const f = fixture = await migrationE2E('oauth-dynamic');
    await f.setSync(true);
    const prepared = await f.move('prepare');
    const result = await f.move('move');
    expect(result.destinationId).toBe(prepared.destinationId);
    expect(result).toMatchObject({ phase: 'active', grantImported: true });
    expect(await f.held.db1.$count(connectors)).toBe(1);
    expect(f.vendor.oauth.registrations).toBe(1);
  });

  test('already signed-in legacy destination is a visible conflict, not overwritten or duplicated', async () => {
    const f = fixture = await migrationE2E('oauth-dynamic');
    await f.setSync(true);
    const prepared = await f.move('prepare');
    await f.completeOAuth(destinationId(prepared));
    const before = await f.destination(destinationId(prepared));
    expect((await f.action('move')).status).toBe(409);
    expect((await f.status()).migrations[0]?.reason).toBe('destination_changed');
    expect(await f.destination(destinationId(prepared))).toEqual(before);
    expect(await f.held.db1.$count(connectors)).toBe(1);
    expect(await f.held.db1.$count(connectorAgents)).toBe(0);
  });
  test('a genuinely uncertain provider refresh recovers by explicit central sign-in on the original client', async () => {
    const f = fixture = await migrationE2E('oauth-dynamic', (source) => {
      if (source.config.auth.kind !== 'oauth') throw new Error('OAuth expected');
      source.config.auth.expiresAt = 1;
    });
    await f.setSync(true);
    const send = f.api.deps.fetch;
    let lost = 0;
    f.api.deps.fetch = (url, init) => {
      if (url === `${VENDOR}/token`) { lost += 1; return Promise.reject(new Error('fixture reply lost')); }
      return send(url, init);
    };
    const pending = await f.move('move');
    expect(pending).toMatchObject({ phase: 'prepared', grantImported: true, reason: 'refresh_uncertain' });
    expect((await f.move('move')).reason).toBe('refresh_uncertain');
    expect(lost).toBe(1);
    expect((await f.action('rollback')).status).toBe(409);
    await f.completeOAuth(destinationId(pending));
    expect((await f.move('move')).phase).toBe('active');
    expect(lost).toBe(1);
    expect(f.vendor.oauth.registrations).toBe(0);
    expect(f.vendor.oauth.tokenForms.at(-1)?.get('client_id')).toBe('old-local-registration');
    expect((await f.destination(destinationId(pending))).secret).toMatchObject({ imported: { state: 'owned' }, tokens: { accessToken: ACCESS } });
  });

});
