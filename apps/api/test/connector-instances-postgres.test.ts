import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { fullPolicy, openConnectorSecret, type ConnectorView } from '../src/connectors/model.js';
import { connectorAgents, connectorEvents, connectorMigrations, connectors } from '../src/db/schema.js';
import { assignConnector, enrollDeliveryAgent, MASTER, newDeliveryAgent, opaque, openResponse, seedConnector, startDeliveryApi, type DeliveryAgent } from './connector-delivery-fixture.js';
import { answer, input, payload, prepareInput, startMigrationApi, verifiedFetch, type MigrationApi } from './connector-migration-fixture.js';
import { postgresFixture, TEST_DATABASE_URL } from './connector-postgres-fixture.js';
import { auth, TEST_OWNER } from './identity-helper.js';
import { startApi, type Api } from './org-connectors-fixture.js';

const TARGET = 'https://vendor.example/mcp?key=URL_SECRET';
const FIRST_KEY = 'Bearer first-fixture-key';
const SECOND_KEY = 'Bearer second-fixture-key';
let held: Awaited<ReturnType<typeof postgresFixture>>;
let one: MigrationApi;
let two: MigrationApi;
let org: Api;
let agent: DeliveryAgent;

async function orgCall<T>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
  const response = await fetch(`${org.base}/api/connectors${path}`, { method, headers: { authorization: await auth(TEST_OWNER), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.status).toBe(status);
  const text = await response.text();
  for (const secret of [FIRST_KEY, SECOND_KEY, 'URL_SECRET']) expect(text).not.toContain(secret);
  return JSON.parse(text) as T;
}

const retry = (body: unknown) => Promise.all([one, two, one, two].map(async (api) => answer(await api.call(agent, body))));
const stored = async () => ({
  connectors: await held.db2.select().from(connectors).orderBy(connectors.id),
  assignments: await held.db2.select().from(connectorAgents).orderBy(connectorAgents.connector),
  mappings: await held.db2.select().from(connectorMigrations).orderBy(connectorMigrations.sourceId),
  events: await held.db2.select().from(connectorEvents).orderBy(connectorEvents.id),
});

describe.skipIf(TEST_DATABASE_URL === undefined)('independent connector instances in real Postgres', () => {
  beforeAll(async () => {
    if (TEST_DATABASE_URL === undefined) throw new Error('TEST_DATABASE_URL is required');
    held = await postgresFixture(TEST_DATABASE_URL);
    one = await startMigrationApi(held.db1);
    two = await startMigrationApi(held.db2);
    org = await startApi(() => held.db1, Date.now, verifiedFetch);
    org.setKey(MASTER);
  }, 30_000);
  beforeEach(async () => {
    await held.reset();
    agent = newDeliveryAgent();
    await enrollDeliveryAgent(held.db1, agent);
  });
  afterAll(async () => { await org?.close(); await one?.close(); await two?.close(); await held?.close(); });

  test('organization create and rename keep identical names and endpoints with independent keys, policies and assignments', async () => {
    const first = (await orgCall<{ connector: ConnectorView }>('POST', '', { name: 'Calendar', url: TARGET, value: FIRST_KEY }, 201)).connector;
    const second = (await orgCall<{ connector: ConnectorView }>('POST', '', { name: 'Calendar', url: TARGET, value: SECOND_KEY }, 201)).connector;
    expect(first.id).not.toBe(second.id);
    await orgCall('PUT', `/${first.id}`, { readOnly: true });
    await orgCall('PUT', `/${first.id}/agents/${agent.row.agent}`, { readOnly: true });
    await orgCall('PUT', `/${second.id}/agents/${agent.row.agent}`, {});
    const before = await stored();
    for (const [view, key, policy] of [[first, FIRST_KEY, { write: 'deny' }], [second, SECOND_KEY, {}]] as const) {
      const row = before.connectors.find((item) => item.id === view.id);
      if (row === undefined) throw new Error('missing connector instance');
      expect(row.name).toBe('Calendar');
      expect(openConnectorSecret(MASTER, row)).toEqual({ kind: 'header', targetUrl: TARGET, name: 'Authorization', value: key });
      expect(fullPolicy(row.policy)).toEqual(policy);
    }
    await orgCall('PUT', `/${first.id}`, { name: 'Renamed' });
    expect(await orgCall<ConnectorView>('PUT', `/${first.id}`, { name: second.name })).toMatchObject({ id: first.id, name: second.name, readOnly: true });
    await orgCall('PUT', `/${first.id}`, { value: 'Bearer rotated-fixture-key' });
    await orgCall('PUT', `/${first.id}`, { readOnly: false });
    const after = await stored();
    expect(after.connectors.find((row) => row.id === second.id)).toEqual(before.connectors.find((row) => row.id === second.id));
    expect(after.assignments).toEqual(before.assignments);
    const changed = after.connectors.find((row) => row.id === first.id);
    if (changed === undefined) throw new Error('missing edited instance');
    expect(openConnectorSecret(MASTER, changed)).toMatchObject({ value: 'Bearer rotated-fixture-key', targetUrl: TARGET });
    expect(fullPolicy(changed.policy)).toEqual({});
    const listed = await orgCall<{ connectors: ConnectorView[] }>('GET', '');
    expect(listed.connectors.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
    expect(listed.connectors.find((row) => row.id === first.id)?.agents).toMatchObject([{ id: agent.row.agent, readOnly: true }]);
    expect(listed.connectors.find((row) => row.id === second.id)?.agents).toMatchObject([{ id: agent.row.agent, readOnly: false }]);
    await orgCall('DELETE', `/${first.id}`);
    expect((await stored()).connectors).toEqual(before.connectors.filter((row) => row.id === second.id));
    expect((await stored()).assignments).toEqual(before.assignments.filter((row) => row.connector === second.id));
  });

  test('distinct local IDs with matching names and endpoints retain durable destinations through concurrent retries and API restart', async () => {
    const legacy = await seedConnector(held.db1, { kind: 'header', targetUrl: TARGET, name: 'Authorization', value: 'Bearer legacy-fixture-key' }, { policy: '{"read":"ask"}' });
    await assignConnector(held.db1, agent, legacy.id, '{"write":"deny"}');
    const original = await stored();
    const sources = [
      { operation: 'oper0000001', source: 'local000001', data: payload({ url: TARGET, auth: { kind: 'header', name: 'Authorization', value: FIRST_KEY }, policy: { write: 'deny', tools: { special: 'ask' } } }) },
      { operation: 'oper0000002', source: 'local000002', data: payload({ url: TARGET, auth: { kind: 'header', name: 'Authorization', value: SECOND_KEY }, policy: { read: 'ask', write: 'allow', tools: { special: 'deny' } } }) },
    ];
    const migrations = await Promise.all(sources.map(async (source) => {
      const responses = await retry(input('begin', source.operation, source.source));
      const begin = responses[0];
      if (begin === undefined) throw new Error('missing migration response');
      for (const response of responses) expect(response).toEqual(begin);
      return { ...source, begin, request: prepareInput(begin, source.data) };
    }));
    const ids = migrations.map(({ begin }) => begin.migration.destinationId);
    expect(new Set([...ids, legacy.id]).size).toBe(3);
    await Promise.all(migrations.map(async ({ request }) => {
      const responses = await retry(request);
      for (const response of responses) expect(response.migration.phase).toBe('prepared');
    }));
    expect(await held.db1.$count(connectors)).toBe(3);
    expect(await held.db1.$count(connectorAgents)).toBe(1);
    await Promise.all(migrations.map(async ({ operation, source }) => {
      for (const response of await retry(input('activate', operation, source))) expect(response.migration.phase).toBe('active');
    }));
    const active = await stored();
    expect(active.connectors).toHaveLength(3);
    expect(active.mappings).toHaveLength(2);
    expect(active.assignments).toHaveLength(3);
    for (const migration of migrations) {
      const id = migration.begin.migration.destinationId;
      const row = active.connectors.find((item) => item.id === id);
      if (row === undefined || migration.data.auth.kind !== 'header') throw new Error('missing migrated header instance');
      expect(row.name).toBe(legacy.name);
      expect(openConnectorSecret(MASTER, row)).toEqual({ ...migration.data.auth, targetUrl: TARGET });
      expect(fullPolicy(row.policy)).toEqual(migration.data.policy);
      expect(active.mappings.find((item) => item.sourceId === migration.source)).toMatchObject({ owner: TEST_OWNER, agent: agent.row.agent, sourceId: migration.source, operationId: migration.operation, destinationId: id, phase: 'active' });
      expect(active.assignments.find((item) => item.connector === id)).toMatchObject({ agent: agent.row.agent, policy: null, migrationOperation: migration.operation });
    }
    await one.close();
    await two.close();
    one = await startMigrationApi(held.db1);
    two = await startMigrationApi(held.db2);
    for (let round = 0; round < 3; round += 1) {
      await Promise.all(migrations.map(async ({ operation, source, begin, request }) => {
        for (const body of [input('begin', operation, source), request, input('activate', operation, source), input('status', operation, source)]) {
          for (const response of await retry(body)) expect(response.migration).toMatchObject({ sourceId: source, operationId: operation, destinationId: begin.migration.destinationId, phase: 'active', readiness: 'ready' });
        }
      }));
    }
    expect(await stored()).toEqual(active);
    expect(active.connectors.find((row) => row.id === legacy.id)).toEqual(legacy);
    expect(active.assignments.find((row) => row.connector === legacy.id)).toEqual(original.assignments[0]);
    const delivery = await startDeliveryApi(held.db2);
    try {
      const requestId = opaque();
      const snapshot = await openResponse(await delivery.call(agent, { requestId }), agent, requestId);
      expect(snapshot.connectors).toHaveLength(3);
      for (const migration of migrations) expect(snapshot.connectors.find((row) => row.id === migration.begin.migration.destinationId)).toMatchObject({ name: legacy.name, url: TARGET, headers: { Authorization: migration.data.auth.kind === 'header' ? migration.data.auth.value : '' }, policy: migration.data.policy, state: 'ready' });
    } finally { await delivery.close(); }
    const first = migrations[0];
    if (first === undefined) throw new Error('missing first source');
    await retry(input('rollback', first.operation, first.source));
    const rolledBack = await stored();
    expect(rolledBack.connectors).toEqual(active.connectors);
    expect(rolledBack.assignments).toEqual(active.assignments.filter((row) => row.connector !== first.begin.migration.destinationId));
    expect(rolledBack.mappings.filter((row) => row.sourceId !== first.source)).toEqual(active.mappings.filter((row) => row.sourceId !== first.source));
  }, 30_000);
});
