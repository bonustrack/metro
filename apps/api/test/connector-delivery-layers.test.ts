import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { CONNECTOR_DELIVERY_MAX_BYTES, DELIVERY_PLAINTEXT_MAX, connectorPolicyOf, effectiveConnectorPolicy, type ConnectorPolicy } from '@metro-labs/http/connector-delivery';
import { connectorAgents, connectors } from '../src/db/schema.js';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.js';
import { CONN, PATH, assignConnector, enrollDeliveryAgent, newDeliveryAgent, opaque, openResponse, seedConnector, signedDelivery, startDeliveryApi, type DeliveryAgent } from './connector-delivery-fixture.js';

let held: TestDb;
let api: Awaited<ReturnType<typeof startDeliveryApi>>;
let agent: DeliveryAgent;
const LAYERED = `${PATH}?policy_layers=1`;
const organization = { read: 'deny', write: 'deny', tools: { find: 'allow' } } as const;
const assignment = { read: 'ask', write: 'ask' } as const;

beforeAll(async () => { held = await testDb(); }, PGLITE_START_MS);
beforeEach(async () => {
  await held.reset();
  agent = newDeliveryAgent();
  await enrollDeliveryAgent(held.db, agent);
  await seedConnector(held.db, { kind: 'header', targetUrl: 'https://vendor.example/private', name: 'Authorization', value: 'SECRET' }, { policy: JSON.stringify(organization) });
  await assignConnector(held.db, agent, CONN, JSON.stringify(assignment));
  api = await startDeliveryApi(held.db);
}, PGLITE_STEP_MS);
afterAll(async () => { await held.close(); });

async function snapshot(path: string) {
  const requestId = opaque();
  const result = await fetch(`${api.base}${path}`, { method: 'POST', ...signedDelivery(agent, { requestId }, Date.now(), path) });
  expect(result.status).toBe(200);
  expect(Buffer.byteLength(await result.clone().text())).toBeLessThanOrEqual(CONNECTOR_DELIVERY_MAX_BYTES);
  const opened = await openResponse(result, agent, requestId);
  expect(Buffer.byteLength(JSON.stringify(opened))).toBeLessThanOrEqual(DELIVERY_PLAINTEXT_MAX);
  return opened;
}

const response = async (path: string) => (await snapshot(path)).connectors[0];
const maximumPolicy = (prefix: string): ConnectorPolicy => connectorPolicyOf({ read: 'ask', write: 'deny', tools: Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`${prefix}${String(index).padStart(4, '0')}${'x'.repeat(251)}`, 'allow'])) });

async function policies(global: ConnectorPolicy, assignmentPolicy: ConnectorPolicy): Promise<void> {
  await held.db.update(connectors).set({ policy: JSON.stringify(global) }).where(eq(connectors.id, CONN));
  await held.db.update(connectorAgents).set({ policy: JSON.stringify(assignmentPolicy) }).where(eq(connectorAgents.connector, CONN));
}

async function neighbor(id = 'conn0000002', policy: ConnectorPolicy = {}): Promise<void> {
  await seedConnector(held.db, { kind: 'header', targetUrl: 'https://vendor.example/neighbor', name: 'Authorization', value: 'NEIGHBOR_SECRET' }, { id, policy: JSON.stringify(policy) });
  await assignConnector(held.db, agent, id);
}

describe('signed connector policy layer negotiation', () => {
  test('older agents receive their unchanged safe shape and no unusable credential', async () => {
    try {
      for (const path of [PATH, `${PATH}?policy_layers=0`, `${PATH}?policy_layers=true`]) {
        const row = await response(path);
        expect(row).not.toHaveProperty('policyLayers');
        expect(row).toMatchObject({ state: 'unavailable', headers: {}, policy: { read: 'deny', write: 'deny', tools: { find: 'deny' } } });
        if (row === undefined) throw new Error('missing fixture');
        expect(effectiveConnectorPolicy(row, { find: 'read' })).toEqual(row.policy);
      }
    } finally { await api.close(); }
  });

  test('opted-in agents get exact layers, named exceptions and organization floors', async () => {
    try {
      const row = await response(LAYERED);
      expect(row).toMatchObject({ state: 'ready', headers: { Authorization: 'SECRET' }, policy: { read: 'deny', write: 'deny' }, policyLayers: { organization, agent: assignment } });
      if (row === undefined) throw new Error('missing fixture');
      expect(effectiveConnectorPolicy(row, { find: 'read' })).toEqual({ read: 'deny', write: 'deny', tools: { find: 'ask' } });
    } finally { await api.close(); }
  });

  test('the maximum admitted named policy arrives intact with another connector and unchanged organization floors', async () => {
    try {
      const maximum = maximumPolicy('a');
      const floor = { read: 'ask', write: 'deny' } as const;
      await policies(maximum, floor);
      await neighbor();
      const rows = (await snapshot(LAYERED)).connectors;
      expect(rows).toHaveLength(2);
      const row = rows.find((entry) => entry.id === CONN);
      if (row === undefined) throw new Error('missing fixture');
      expect(row).toMatchObject({ state: 'ready', policy: { read: 'deny', write: 'deny' }, policyLayers: { organization: maximum, agent: floor } });
      const names = Object.keys(maximum.tools ?? {});
      const groups = Object.fromEntries(names.map((name, index) => [name, index % 2 === 0 ? 'read' : 'write'] as const));
      const effective = effectiveConnectorPolicy(row, groups);
      expect(effective.read).toBe('ask');
      expect(effective.write).toBe('deny');
      for (const [index, name] of names.entries()) expect(effective.tools?.[name]).toBe(index % 2 === 0 ? 'ask' : 'deny');
      expect(rows.find((entry) => entry.id === 'conn0000002')).toMatchObject({ state: 'ready', headers: { Authorization: 'NEIGHBOR_SECRET' } });
    } finally { await api.close(); }
  });

  test('two disjoint maximum layers fail closed only for their connector and preserve saved rules', async () => {
    try {
      const first = maximumPolicy('a');
      const second = maximumPolicy('b');
      await policies(first, second);
      await neighbor();
      const rows = (await snapshot(LAYERED)).connectors;
      expect(rows).toHaveLength(2);
      const row = rows.find((entry) => entry.id === CONN);
      expect(row).toEqual({ id: CONN, name: 'Calendar', url: 'https://vendor.example', auth: 'header', revision: row?.revision, state: 'unavailable', headers: {}, policy: { read: 'deny', write: 'deny' } });
      if (row === undefined) throw new Error('missing fixture');
      expect(effectiveConnectorPolicy(row, {})).toEqual({ read: 'deny', write: 'deny' });
      expect(rows.find((entry) => entry.id === 'conn0000002')).toMatchObject({ state: 'ready', headers: { Authorization: 'NEIGHBOR_SECRET' } });
      expect((await held.db.select().from(connectors).where(eq(connectors.id, CONN)))[0]?.policy).toBe(JSON.stringify(first));
      expect((await held.db.select().from(connectorAgents).where(eq(connectorAgents.connector, CONN)))[0]?.policy).toBe(JSON.stringify(second));
    } finally { await api.close(); }
  });

  test('aggregate size limits disable large payloads without stranding a small connector in either wire format', async () => {
    try {
      const maximum = maximumPolicy('a');
      await policies(maximum, {});
      await neighbor('conn0000002', maximumPolicy('b'));
      await neighbor('conn0000003');
      for (const path of [PATH, LAYERED]) {
        const rows = (await snapshot(path)).connectors;
        expect(rows).toHaveLength(3);
        expect(rows.filter((row) => row.state === 'unavailable')).toHaveLength(1);
        expect(rows.filter((row) => row.state === 'ready')).toHaveLength(2);
        expect(rows.find((row) => row.id === 'conn0000003')).toMatchObject({ state: 'ready', headers: { Authorization: 'NEIGHBOR_SECRET' } });
        const refused = rows.find((row) => row.state === 'unavailable');
        expect(refused).toMatchObject({ headers: {}, policy: { read: 'deny', write: 'deny' } });
        expect(refused).not.toHaveProperty('policyLayers');
      }
    } finally { await api.close(); }
  });

  test('adding or removing the opt-in after signing is refused', async () => {
    try {
      expect((await fetch(`${api.base}${LAYERED}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: opaque() }) })).status).toBe(401);
      for (const [signed, sent] of [[PATH, LAYERED], [LAYERED, PATH]] as const) {
        const request = signedDelivery(agent, { requestId: opaque() }, Date.now(), signed);
        expect((await fetch(`${api.base}${sent}`, { method: 'POST', ...request })).status).toBe(401);
      }
    } finally { await api.close(); }
  });
});
