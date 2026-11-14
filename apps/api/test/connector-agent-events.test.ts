import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { RemoteEvent } from '@metro-labs/http/connector-tools';
import { saveToolListing } from '@metro-labs/connectors/db/connector-tools';
import type { AssignmentRow, ConnectorRow } from '@metro-labs/connectors/db/connectors';
import { connectorAgents, connectors, connectorSubscriptions } from '../src/db/schema.ts';
import { connectorView, type ConnectorView } from '../src/connectors/model.ts';
import { auth, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { addAgent, addRemoteAgent, PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { startApi, type Api } from './org-connectors-fixture.ts';

const OURS = 'agent000001';
const SECOND = 'agent000002';
const REMOTE = 'agent000003';
const THEIRS = 'agent000004';
const TRACKER = 'conn0000001';
const PLAIN = 'conn0000002';
const FOREIGN = 'conn0000003';
const AT = '2026-11-09T00:00:00.000Z';
const NOW = Date.parse('2026-11-10T09:00:00.000Z');
const NO_SERVER = 'This agent has no server, so it cannot receive events. It can still use the tools.';

const CREATED: RemoteEvent = { name: 'item.created', title: 'Item created', description: 'A new item was added.', delivery: ['webhook'], sender: { id: '/author/id', verified: '/author/verified' } };
const UPDATED: RemoteEvent = { name: 'item.updated', title: 'Item updated', description: '', delivery: ['webhook', 'poll'] };
const POLLED: RemoteEvent = { name: 'item.polled', title: 'Item polled', description: 'Only by asking.', delivery: ['poll'] };

let held: TestDb;
let api: Api;
let serial = 0;

type Agent = ConnectorView['agents'][number];

const call = async (method: string, path: string, body?: unknown, authorization?: string): Promise<Response> =>
  fetch(`${api.base}/api/connectors${path}`, {
    method,
    headers: { authorization: authorization ?? (await auth(TEST_OWNER)), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const view = async (response: Response): Promise<ConnectorView> => {
  expect(response.status).toBe(200);
  return (await response.json()) as ConnectorView;
};

const refused = async (response: Response, status: number): Promise<string> => {
  expect(response.status).toBe(status);
  return ((await response.json()) as { error: string }).error;
};

const put = (connector: string, agent: string, body: unknown, authorization?: string): Promise<Response> => call('PUT', `/${connector}/agents/${agent}/events`, body, authorization);

const agentOf = (connector: ConnectorView, id: string): Agent | undefined => connector.agents.find((agent) => agent.id === id);

async function addConnector(id: string, owner: string, name: string): Promise<void> {
  await held.db.insert(connectors).values({ id, owner, name, url: `https://${name.toLowerCase()}.example`, auth: 'header', createdBy: 'user_01TEST', createdAt: AT, updatedAt: AT });
}

const offer = (connector: string, events: RemoteEvent[]): Promise<void> => saveToolListing(held.db, connector, { tools: [], icons: [], events, listedAt: NOW, failure: null, failedAt: 0 });

async function assign(connector: string, agent: string, patch: Partial<AssignmentRow> = {}): Promise<void> {
  await held.db.insert(connectorAgents).values({ connector, agent, createdBy: 'user_01TEST', createdAt: AT, ...patch });
}

async function subscribe(connector: string, agent: string, event: string, status: string, error: string | null = null, owner = TEST_OWNER): Promise<void> {
  serial += 1;
  await held.db.insert(connectorSubscriptions).values({ id: `subs${String(serial).padStart(7, '0')}`, owner, connector, agent, event, secret: 'sealed-fixture', status, error, signedIn: '' });
}

const stored = async (connector: string, agent: string): Promise<{ events: string; senders: string } | undefined> =>
  (await held.db.select({ events: connectorAgents.events, senders: connectorAgents.senders }).from(connectorAgents).where(and(eq(connectorAgents.connector, connector), eq(connectorAgents.agent, agent))))[0];

beforeAll(async () => {
  held = await testDb();
  api = await startApi(() => held.db, () => NOW, () => Promise.reject(new Error('no vendor in this test')));
}, PGLITE_START_MS);

beforeEach(async () => {
  await held.reset();
  await addAgent(held.db, OURS, TEST_OWNER);
  await addAgent(held.db, SECOND, TEST_OWNER);
  await addRemoteAgent(held.db, REMOTE, TEST_OWNER, 'Laptop');
  await addAgent(held.db, THEIRS, TEST_STRANGER);
  await addConnector(TRACKER, TEST_OWNER, 'Tracker');
  await addConnector(PLAIN, TEST_OWNER, 'Plain');
  await addConnector(FOREIGN, TEST_STRANGER, 'Foreign');
  await offer(TRACKER, [CREATED, UPDATED, POLLED]);
  await assign(TRACKER, OURS);
}, PGLITE_STEP_MS);

afterAll(async () => {
  await api.close();
  await held.close();
});

describe('events in the connector view', () => {
  test('a connector lists what its server offers by webhook, and each agent what it receives, from whom and how the subscription stands', async () => {
    await assign(TRACKER, SECOND, { events: '["item.created"]', senders: '["@example.com","lisa@example.org"]' });
    await subscribe(TRACKER, SECOND, 'item.updated', 'error', 'The connector refused the subscription.');
    await subscribe(TRACKER, SECOND, 'item.created', 'active');
    await subscribe(TRACKER, OURS, 'item.created', 'signed_out');
    const listed = (await (await call('GET', '', undefined, await auth(TEST_OWNER, 'member'))).json()) as { connectors: ConnectorView[] };
    const tracker = listed.connectors.find((row) => row.id === TRACKER);
    expect(tracker?.events).toEqual([
      { name: 'item.created', title: 'Item created', description: 'A new item was added.', sender: true },
      { name: 'item.updated', title: 'Item updated', description: '', sender: false },
    ]);
    expect(tracker === undefined ? undefined : agentOf(tracker, SECOND)).toEqual({
      id: SECOND, readOnly: false, policy: {}, assignedAt: AT, events: ['item.created'], senders: ['@example.com', 'lisa@example.org'],
      subscriptions: [{ event: 'item.created', status: 'active' }, { event: 'item.updated', status: 'error', error: 'The connector refused the subscription.' }],
    });
    expect(tracker === undefined ? undefined : agentOf(tracker, OURS)).toMatchObject({ events: [], senders: ['*'], subscriptions: [{ event: 'item.created', status: 'signed_out' }] });
    expect(listed.connectors.find((row) => row.id === PLAIN)).toMatchObject({ events: [], agents: [] });
    expect(await view(await call('GET', `/${TRACKER}`))).toEqual(tracker as ConnectorView);
  });

  test('another organization never sees these events, people or subscriptions, and its own never show here', async () => {
    await offer(FOREIGN, [UPDATED]);
    await assign(FOREIGN, THEIRS, { events: '["item.updated"]', senders: '["them@example.net"]' });
    await subscribe(FOREIGN, THEIRS, 'item.updated', 'active', null, TEST_STRANGER);
    await subscribe(TRACKER, OURS, 'item.created', 'active');
    const ours = await (await call('GET', '')).text();
    expect(ours).not.toContain('them@example.net');
    expect(ours).not.toContain(FOREIGN);
    const theirs = (await (await call('GET', '', undefined, await auth(TEST_STRANGER))).json()) as { connectors: ConnectorView[] };
    expect(theirs.connectors.map((row) => row.id)).toEqual([FOREIGN]);
    expect(theirs.connectors[0]).toMatchObject({ events: [{ name: 'item.updated', sender: false }], agents: [{ id: THEIRS, events: ['item.updated'], senders: ['them@example.net'], subscriptions: [{ event: 'item.updated', status: 'active' }] }] });
  });

  test('a stored value Metro cannot read falls back to nothing wanted, nobody listed, and a subscription still connecting', () => {
    const row: ConnectorRow = { id: TRACKER, owner: TEST_OWNER, name: 'Tracker', url: 'https://tracker.example', auth: 'header', authGeneration: null, policy: null, secret: null, detail: null, createdBy: 'user_01TEST', createdAt: AT, updatedAt: AT };
    const assignment: AssignmentRow = { connector: TRACKER, agent: OURS, policy: null, createdBy: 'user_01TEST', createdAt: AT, events: '{"item.created":true}', senders: 'not json' };
    const shown = connectorView(row, [assignment, { ...assignment, agent: SECOND, events: '["item.created","bad name","item.created",7]', senders: '[]' }], {
      offered: new Map([[TRACKER, [CREATED]], [PLAIN, [UPDATED]]]),
      subscriptions: [
        { connector: TRACKER, agent: OURS, event: 'item.created', status: 'later', error: '' },
        { connector: PLAIN, agent: OURS, event: 'item.updated', status: 'active', error: null },
        { connector: TRACKER, agent: THEIRS, event: 'item.created', status: 'active', error: null },
      ],
    });
    expect(shown.events).toEqual([{ name: 'item.created', title: 'Item created', description: 'A new item was added.', sender: true }]);
    expect(agentOf(shown, OURS)).toMatchObject({ events: [], senders: [], subscriptions: [{ event: 'item.created', status: 'pending' }] });
    expect(agentOf(shown, SECOND)).toMatchObject({ events: ['item.created'], senders: ['*'], subscriptions: [] });
    expect(connectorView(row, [assignment])).toMatchObject({ events: [], agents: [{ id: OURS, events: [], senders: [], subscriptions: [] }] });
  });
});

describe('turning event types on and off for one agent', () => {
  test('an admin changes what an agent receives and from whom, a member cannot, and the answer is the connector', async () => {
    const member = await auth(TEST_OWNER, 'member');
    expect(await refused(await put(TRACKER, OURS, { events: ['item.created'] }, member), 403)).toContain('admin');
    expect(await stored(TRACKER, OURS)).toEqual({ events: '[]', senders: '["*"]' });
    await assign(TRACKER, SECOND);
    const on = await view(await put(TRACKER, OURS, { events: ['item.created'] }));
    expect(on.id).toBe(TRACKER);
    expect(agentOf(on, OURS)).toMatchObject({ events: ['item.created'], senders: ['*'], subscriptions: [] });
    const both = await view(await put(TRACKER, OURS, { events: ['item.created', 'item.updated', 'item.created'] }));
    expect(agentOf(both, OURS)?.events).toEqual(['item.created', 'item.updated']);
    const people = await view(await put(TRACKER, OURS, { senders: [' Lisa@Example.org ', '@Example.COM', 'lisa@example.org', ''] }));
    expect(agentOf(people, OURS)).toMatchObject({ events: ['item.created', 'item.updated'], senders: ['Lisa@Example.org', '@example.com'] });
    const off = await view(await put(TRACKER, OURS, { events: [], senders: ['someone@example.org', '*'] }));
    expect(agentOf(off, OURS)).toMatchObject({ events: [], senders: ['*'] });
    expect(agentOf(off, SECOND)).toMatchObject({ events: [], senders: ['*'] });
    expect(await stored(TRACKER, SECOND)).toEqual({ events: '[]', senders: '["*"]' });
    expect(agentOf(await view(await put(TRACKER, OURS, { senders: [] })), OURS)?.senders).toEqual(['*']);
  });

  test('a name the connector does not offer cannot be turned on, but one that is on can be kept or turned off', async () => {
    expect(await refused(await put(TRACKER, OURS, { events: ['item.deleted'] }), 400)).toBe('This connector does not offer "item.deleted".');
    expect(await refused(await put(TRACKER, OURS, { events: ['item.created', 'item.polled'] }), 400)).toBe('This connector does not offer "item.polled".');
    expect(await stored(TRACKER, OURS)).toEqual({ events: '[]', senders: '["*"]' });
    await view(await put(TRACKER, OURS, { events: ['item.created', 'item.updated'] }));
    await offer(TRACKER, [CREATED]);
    expect((await view(await call('GET', `/${TRACKER}`))).events.map((event) => event.name)).toEqual(['item.created']);
    expect(agentOf(await view(await put(TRACKER, OURS, { events: ['item.updated', 'item.created'] })), OURS)?.events).toEqual(['item.updated', 'item.created']);
    expect(agentOf(await view(await put(TRACKER, OURS, { events: ['item.updated'] })), OURS)?.events).toEqual(['item.updated']);
    expect(agentOf(await view(await put(TRACKER, OURS, { events: [] })), OURS)?.events).toEqual([]);
    expect(await refused(await put(TRACKER, OURS, { events: ['item.updated'] }), 400)).toBe('This connector does not offer "item.updated".');
    await assign(PLAIN, OURS);
    expect(await refused(await put(PLAIN, OURS, { events: ['item.created'] }), 400)).toBe('This connector does not offer "item.created".');
    expect(agentOf(await view(await put(PLAIN, OURS, { events: [] })), OURS)?.events).toEqual([]);
  });

  test('a malformed body is refused with a sentence and nothing is saved', async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `item.created${String(i)}`);
    const bodies: unknown[] = [
      {}, [], 'item.created', { policy: {} }, { events: [], extra: true }, { events: 'item.created' }, { events: [7] }, { events: ['bad name'] }, { events: [''] }, { events: ['.hidden'] },
      { events: ['x'.repeat(129)] }, { events: tooMany }, { senders: 'me@example.org' }, { senders: [7] }, { senders: ['@nope'] }, { senders: ['x'.repeat(201)] }, { events: ['item.created'], senders: null },
    ];
    for (const body of bodies) {
      const error = await refused(await put(TRACKER, OURS, body), 400);
      expect(error.length).toBeGreaterThan(10);
    }
    expect(await stored(TRACKER, OURS)).toEqual({ events: '[]', senders: '["*"]' });
    expect(agentOf(await view(await put(TRACKER, OURS, { events: Array.from({ length: 50 }, () => 'item.created') })), OURS)?.events).toEqual(['item.created']);
  });

  test('an agent without the connector, another organization or an unknown connector is a 404, and only PUT is answered', async () => {
    expect(await refused(await put(TRACKER, SECOND, { events: ['item.created'] }), 404)).toBe('that agent does not have this connector');
    expect(await refused(await put(TRACKER, SECOND, { senders: ['a@example.org'] }), 404)).toBe('that agent does not have this connector');
    expect((await put(TRACKER, THEIRS, { events: [] })).status).toBe(404);
    expect((await put('conn0000009', OURS, { events: ['item.created'] })).status).toBe(404);
    expect((await put('conn0000009', OURS, { senders: ['*'] })).status).toBe(404);
    const stranger = await auth(TEST_STRANGER);
    expect((await put(TRACKER, OURS, { events: ['item.created'] }, stranger)).status).toBe(404);
    expect((await put(TRACKER, OURS, { senders: ['them@example.net'] }, stranger)).status).toBe(404);
    expect(await stored(TRACKER, OURS)).toEqual({ events: '[]', senders: '["*"]' });
    expect((await call('GET', `/${TRACKER}/agents/${OURS}/events`)).status).toBe(405);
    expect((await call('DELETE', `/${TRACKER}/agents/${OURS}/events`)).status).toBe(405);
    expect((await call('PUT', `/${TRACKER}/agents/${OURS}/events/extra`, { events: [] })).status).toBe(404);
    expect((await fetch(`${api.base}/api/connectors/${TRACKER}/agents/${OURS}/events`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"events":[]}' })).status).toBe(401);
  });

  test('an agent without a server cannot receive events, and says why, but everything else still saves', async () => {
    await assign(TRACKER, REMOTE);
    expect(await refused(await put(TRACKER, REMOTE, { events: ['item.created'] }), 409)).toBe(NO_SERVER);
    expect(await refused(await put(TRACKER, REMOTE, { events: ['item.created'], senders: ['a@example.org'] }), 409)).toBe(NO_SERVER);
    expect(await stored(TRACKER, REMOTE)).toEqual({ events: '[]', senders: '["*"]' });
    expect(agentOf(await view(await put(TRACKER, REMOTE, { events: [] })), REMOTE)?.events).toEqual([]);
    expect(agentOf(await view(await put(TRACKER, REMOTE, { senders: ['a@example.org'] })), REMOTE)).toMatchObject({ events: [], senders: ['a@example.org'] });
  });
});
