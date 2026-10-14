import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { fullPolicy, openConnectorSecret, type ConnectorView } from '../src/connectors/model.js';
import { connectorAgents, connectors } from '../src/db/schema.js';
import { enrollDeliveryAgent, MASTER, newDeliveryAgent, type DeliveryAgent } from './connector-delivery-fixture.js';
import { postgresFixture, TEST_DATABASE_URL } from './connector-postgres-fixture.js';
import { auth, TEST_OWNER } from './identity-helper.js';
import { startApi, type Api } from './org-connectors-fixture.js';

const TARGET = 'https://vendor.example/mcp?key=URL_SECRET';
const FIRST_KEY = 'Bearer first-fixture-key';
const SECOND_KEY = 'Bearer second-fixture-key';
const verifiedFetch: FetchLike = () => Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', serverInfo: { name: 'Fixture MCP' } } }));
let held: Awaited<ReturnType<typeof postgresFixture>>;
let org: Api;
let agent: DeliveryAgent;

async function orgCall<T>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
  const response = await fetch(`${org.base}/api/connectors${path}`, { method, headers: { authorization: await auth(TEST_OWNER), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.status).toBe(status);
  const text = await response.text();
  for (const secret of [FIRST_KEY, SECOND_KEY, 'URL_SECRET']) expect(text).not.toContain(secret);
  return JSON.parse(text) as T;
}

const stored = async () => ({
  connectors: await held.db2.select().from(connectors).orderBy(connectors.id),
  assignments: await held.db2.select().from(connectorAgents).orderBy(connectorAgents.connector),
});

describe.skipIf(TEST_DATABASE_URL === undefined)('independent connector instances in real Postgres', () => {
  beforeAll(async () => {
    if (TEST_DATABASE_URL === undefined) throw new Error('TEST_DATABASE_URL is required');
    held = await postgresFixture(TEST_DATABASE_URL);
    org = await startApi(() => held.db1, Date.now, verifiedFetch);
    org.setKey(MASTER);
  }, 30_000);
  beforeEach(async () => {
    await held.reset();
    agent = newDeliveryAgent();
    await enrollDeliveryAgent(held.db1, agent);
  });
  afterAll(async () => { await org?.close(); await held?.close(); });

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
});
