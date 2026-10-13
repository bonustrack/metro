import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { enrollDeliveryAgent, newDeliveryAgent } from '../../api/test/connector-delivery-fixture.js';
import { connectorAgents, connectorMigrations, connectors } from '../../api/src/db/schema.js';
import { newAgentKey, saveAgentKey } from '../src/connectors/agent-key.js';
import { readLocalConnectors } from '../src/connectors/store.js';
import { destinationId, MIGRATIONS, migrationE2E, SOURCE, TEST_DATABASE_URL, TEST_OWNER, TEST_STRANGER, UNMIGRATED, type MigrationE2E } from './migration-e2e-fixture.js';
import { POLICY } from './migration-e2e-vendor.js';

let fixture: MigrationE2E | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

async function active(f: MigrationE2E) {
  await f.setSync(true); await f.move('prepare');
  const record = await f.move('cutover'); expect(record.phase).toBe('active'); return record;
}

describe.skipIf(TEST_DATABASE_URL === undefined)('migration recovery through daemon HTTP, real API and isolated PostgreSQL', () => {
  test('lost committed prepare, activate and rollback responses reconcile their original IDs with no duplicate rows', async () => {
    const f = fixture = await migrationE2E();
    await f.setSync(true);
    f.faults.drop = 'prepare'; expect((await f.action('prepare')).status).toBe(503);
    const original = (await f.status()).migrations[0];
    if (original === undefined) throw new Error('missing durable operation');
    expect(original.phase).toBe('preparing');
    expect(await f.held.db1.$count(connectors)).toBe(1);
    expect(await f.held.db1.$count(connectorAgents)).toBe(0);
    await f.restart();
    const prepared = await f.move('reconcile');
    expect(prepared).toMatchObject({ id: original.id, destinationId: original.destinationId, phase: 'prepared' });
    f.faults.drop = 'activate'; expect((await f.action('cutover')).status).toBe(503);
    expect((await f.status()).migrations[0]?.phase).toBe('cutover');
    expect(await f.held.db1.$count(connectorAgents)).toBe(1);
    const before = f.vendor.calls.length;
    expect((await f.tool()).status).toBe(409); expect(f.vendor.calls.length).toBe(before);
    await f.restart();
    expect((await f.tool()).status).toBe(409);
    expect(await f.move('reconcile')).toMatchObject({ id: original.id, destinationId: original.destinationId, phase: 'active' });
    expect((await f.tool()).status).toBe(200);
    f.faults.drop = 'rollback'; expect((await f.action('rollback')).status).toBe(503);
    expect((await f.status()).migrations[0]?.phase).toBe('rollback');
    expect(await f.held.db1.$count(connectorAgents)).toBe(0);
    expect((await f.tool()).status).toBe(409);
    await f.restart();
    expect((await f.tool()).status).toBe(409);
    expect(await f.move('reconcile')).toMatchObject({ id: original.id, destinationId: original.destinationId, phase: 'rolled_back' });
    expect((await f.tool()).status).toBe(200);
    expect(await f.held.db1.$count(connectors)).toBe(1);
    expect(await f.held.db1.$count(connectorMigrations)).toBe(1);
    const bodies = f.traffic.filter((row) => row.path.endsWith('/connector-migrations')).map((row) => JSON.parse(row.body) as { operationId: string; sourceId: string });
    expect(new Set(bodies.map((body) => body.operationId))).toEqual(new Set([original.id]));
    expect(new Set(bodies.map((body) => body.sourceId))).toEqual(new Set([SOURCE]));
    expect(new Set(f.traffic.map((row) => row.authorization)).size).toBe(f.traffic.length);
  });

  test('network outage leaves prepared local use intact; bad sealed delivery cannot activate the alias or restore the retired source', async () => {
    const f = fixture = await migrationE2E();
    await f.setSync(true); const prepared = await f.move('prepare');
    f.faults.offline = true;
    expect((await f.action('cutover')).status).toBe(503);
    expect((await f.status()).migrations[0]?.phase).toBe('prepared');
    expect((await f.tool()).status).toBe(200);
    expect(await f.held.db1.$count(connectorAgents)).toBe(0);
    f.faults.offline = false; f.faults.badDelivery = true;
    const refused = await f.action('cutover');
    expect(refused.status).toBeGreaterThanOrEqual(500);
    expect(await refused.text()).not.toContain('good-vendor-key-fixture');
    expect((await f.status()).migrations[0]?.phase).toBe('cutover');
    expect(await f.held.db1.$count(connectorAgents)).toBe(1);
    const before = f.vendor.calls.length;
    expect((await f.tool()).status).toBe(409); expect(f.vendor.calls.length).toBe(before);
    f.faults.badDelivery = false;
    expect(await f.move('reconcile')).toMatchObject({ id: prepared.id, phase: 'active' });
    f.faults.offline = true;
    expect((await f.tool()).status).toBe(503); expect(f.vendor.calls.length).toBe(before);
    f.faults.offline = false;
    expect((await f.tool()).status).toBe(200);
  });

  test('failed vendor verification retries the same preparation without creating an unusable destination', async () => {
    const f = fixture = await migrationE2E();
    await f.setSync(true); f.vendor.unavailable(true);
    expect((await f.action('prepare')).status).toBe(503);
    const failed = (await f.status()).migrations[0]; if (failed === undefined) throw new Error('missing failed operation');
    expect(failed.phase).toBe('preparing');
    expect(await f.held.db1.$count(connectors)).toBe(0);
    expect(await f.held.db1.$count(connectorAgents)).toBe(0);
    f.vendor.unavailable(false);
    expect((await f.tool()).status).toBe(200);
    expect(await f.move('reconcile')).toMatchObject({ id: failed.id, destinationId: failed.destinationId, phase: 'prepared' });
    expect(await f.held.db1.$count(connectorMigrations)).toBe(1);
    expect(await f.held.db1.$count(connectors)).toBe(1);
    expect(await f.held.db1.$count(connectorAgents)).toBe(0);
  });

  test('sync Off removes the active alias without resurrecting the local source, while unmigrated connectors still run', async () => {
    const f = fixture = await migrationE2E();
    await active(f); expect((await f.tool()).status).toBe(200);
    await f.setSync(false);
    const before = f.vendor.calls.length;
    expect((await f.tool()).status).toBe(503); expect(f.vendor.calls.length).toBe(before);
    expect(f.plugins()['migration-fixture']).toBeUndefined();
    expect((await f.tool('read_item', UNMIGRATED)).status).toBe(200);
    expect(await f.held.db1.$count(connectorAgents)).toBe(1);
    expect((await f.move('rollback')).phase).toBe('rolled_back');
    expect((await f.tool()).status).toBe(200);
    expect(await f.held.db1.$count(connectorAgents)).toBe(0);
  });

  test('local and central ordinary policy edits cannot silently replace the migrated per-tool policy', async () => {
    const f = fixture = await migrationE2E();
    await f.setSync(true); const prepared = await f.move('prepare'); const id = destinationId(prepared);
    expect((await f.request(`/api/connectors/${SOURCE}/policy`, 'PUT', { policy: { read: 'allow', write: 'allow' } })).status).toBe(409);
    expect((await f.manage(`/${id}`, 'PUT', { readOnly: false })).status).toBe(409);
    expect((await f.manage(`/${id}`, 'PUT', { readOnly: true })).status).toBe(409);
    expect(JSON.parse((await f.destination(id)).row.policy ?? '{}')).toEqual(POLICY);
    expect((await f.manage(`/${id}`, 'PUT', { name: 'Deliberately changed destination' })).status).toBe(409);
    expect((await f.move('cutover')).phase).toBe('active');
    expect((await f.manage(`/${id}`, 'PUT', { readOnly: false })).status).toBe(409);
    expect((await f.manage(`/${id}`, 'PUT', { name: 'Deliberately changed destination' })).status).toBe(200);
    expect((await f.move('rollback')).phase).toBe('rolled_back');
    expect((await f.destination(id)).row.name).toBe('Deliberately changed destination');
  });

  test('out-of-band policy drift after prepare blocks cutover rather than weakening exact preservation', async () => {
    const f = fixture = await migrationE2E();
    const rows = readLocalConnectors(f.dir);
    const source = rows.find((row) => row.id === SOURCE); if (source === undefined) throw new Error('missing source');
    source.config.policy = {};
    writeFileSync(join(f.dir, 'connectors.json'), JSON.stringify({ version: 1, connectors: rows }));
    await f.setSync(true); const id = destinationId(await f.move('prepare'));
    expect((await f.manage(`/${id}`, 'PUT', { readOnly: true })).status).toBe(409);
    await f.held.two`update connectors set policy = ${JSON.stringify({ write: 'deny' })} where id = ${id}`;
    expect(await f.move('cutover')).toMatchObject({ phase: 'prepared', reason: 'destination_changed' });
    expect(await f.held.db1.$count(connectorAgents)).toBe(0);
  });

  test('deny-both group defaults retain named allow and ask exceptions through sealed delivery and runtime gates', async () => {
    const f = fixture = await migrationE2E();
    const rows = readLocalConnectors(f.dir);
    const source = rows.find((row) => row.id === SOURCE); if (source === undefined) throw new Error('missing source');
    const policy = { read: 'deny', write: 'deny', tools: { special: 'ask', exception: 'allow' } } as const;
    source.config.policy = policy;
    writeFileSync(join(f.dir, 'connectors.json'), JSON.stringify({ version: 1, connectors: rows }));
    const id = destinationId(await active(f));
    expect(JSON.parse((await f.destination(id)).row.policy ?? '{}')).toEqual(policy);
    const before = f.vendor.calls.length;
    expect((await f.tool('exception')).status).toBe(200);
    expect(await (await f.tool('special')).text()).toContain('approval');
    expect(await (await f.tool('read_item')).text()).toContain("Blocked by the owner's policy");
    expect(await (await f.tool('write_item')).text()).toContain("Blocked by the owner's policy");
    expect(f.vendor.calls.slice(before).map((call) => call.tool)).toEqual(['exception']);
  });

  for (const edit of ['other-agent', 'same-agent-noop', 'same-agent-reassignment'] as const) {
    test(`rollback preserves ${edit} grants, destination configuration and all unrelated assignments`, async () => {
      const f = fixture = await migrationE2E();
      const id = destinationId(await active(f));
      const other = newDeliveryAgent('agent000002'); await enrollDeliveryAgent(f.held.db2, other);
      expect((await f.manage(`/${id}/agents/${other.row.agent}`, 'PUT', {})).status).toBe(200);
      if (edit === 'same-agent-reassignment') expect((await f.manage(`/${id}/agents/${f.agent.row.agent}`, 'DELETE')).status).toBe(200);
      if (edit !== 'other-agent') expect((await f.manage(`/${id}/agents/${f.agent.row.agent}`, 'PUT', {})).status).toBe(200);
      const before = (await f.destination(id)).row;
      expect((await f.move('rollback')).phase).toBe('rolled_back');
      const assignments = await f.held.db1.select().from(connectorAgents);
      expect(assignments.map((row) => row.agent).sort()).toEqual((edit === 'other-agent' ? [other.row.agent] : [f.agent.row.agent, other.row.agent]).sort());
      expect((await f.destination(id)).row).toEqual(before);
      expect(await f.held.db1.$count(connectors)).toBe(1);
      expect((await f.tool()).status).toBe(200);
      expect(f.plugins()['migration-fixture']?.url).toEndWith(`/relay/${SOURCE}`);
    });
  }

  test('key rotation and owner changes fail closed at the retained alias and stale browser scope', async () => {
    const f = fixture = await migrationE2E();
    await active(f); const scope = (await f.status()).scope;
    const enrollment = f.key.enrollment; if (enrollment === null) throw new Error('missing enrollment');
    saveAgentKey(newAgentKey(), enrollment, f.dir);
    const before = f.vendor.calls.length;
    expect((await f.tool()).status).toBe(503);
    expect((await f.action('rollback', scope)).status).toBe(409);
    expect((await f.status()).migrations[0]?.reason).toBe('identity_changed');
    expect(f.vendor.calls.length).toBe(before);
    saveAgentKey(f.key, enrollment, f.dir);
    writeFileSync(join(f.dir, '.owner'), TEST_STRANGER);
    expect((await f.request(MIGRATIONS)).status).toBe(403);
    expect((await f.request(MIGRATIONS, 'GET', undefined, f.stranger)).status).toBe(200);
    expect((await f.tool()).status).toBe(503);
    expect(f.vendor.calls.length).toBe(before);
    expect(await f.held.db1.$count(connectorAgents)).toBe(1);
    expect(readFileSync(join(f.dir, 'connectors.json'), 'utf8')).toContain('good-vendor-key-fixture');
    writeFileSync(join(f.dir, '.owner'), TEST_OWNER);
    expect((await f.move('rollback')).phase).toBe('rolled_back');
    expect((await f.tool()).status).toBe(200);
  });
});
