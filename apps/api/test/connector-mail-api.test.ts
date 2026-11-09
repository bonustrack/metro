import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { saveToolListing } from '@metro-labs/connectors/db/connector-tools';
import { connectorAgents } from '../src/db/schema.ts';
import { auth, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { addAgent, PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { addUser, GOOD_KEY, startApi, startVendor, type Api, type Vendor } from './org-connectors-fixture.ts';

const OURS = 'agent000001';
const THEIRS = 'agent000003';

let held: TestDb;
let vendor: Vendor;
let api: Api;
let now = Date.parse('2026-11-09T09:00:00.000Z');

interface View {
  id: string;
  events: string[];
  agents: { id: string; senders: string[]; receive: boolean }[];
}

const call = async (method: string, path: string, body?: unknown, authorization?: string): Promise<Response> => {
  now += 1;
  return fetch(`${api.base}${path}`, {
    method,
    headers: { authorization: authorization ?? (await auth(TEST_OWNER)), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
};

const view = async (res: Response): Promise<View> => (await res.json()) as View;

async function mailConnector(): Promise<View> {
  const res = await call('POST', '/api/connectors', { name: 'Gmail', url: `${vendor.base}/keyed`, value: GOOD_KEY });
  const created = ((await res.json()) as { connector: View }).connector;
  await saveToolListing(held.db, created.id, { tools: [], icons: [], events: [{ name: 'email.received', delivery: ['webhook'] }, { name: 'calendar.changed', delivery: ['poll'] }], listedAt: now, failure: null, failedAt: 0 });
  await call('PUT', `/api/connectors/${created.id}/agents/${OURS}`, {});
  return created;
}

beforeAll(async () => {
  held = await testDb();
  vendor = await startVendor();
  api = await startApi(() => held.db, () => now, vendor.fetch);
}, PGLITE_START_MS);

beforeEach(async () => {
  now += 60_000;
  await held.reset();
  await addAgent(held.db, OURS, TEST_OWNER);
  await addAgent(held.db, THEIRS, TEST_STRANGER);
  await addUser(held.db, 'user_01ABC', 'Less', 'less@example.com');
}, PGLITE_STEP_MS);

afterAll(async () => {
  await api.close();
  await vendor.close();
  await held.close();
});

describe('a mail connector on the page', () => {
  test('lists the events its server delivers by webhook, and anyone may write by default with Receive messages on', async () => {
    const created = await mailConnector();
    const shown = await view(await call('GET', `/api/connectors/${created.id}`));
    expect(shown.events).toEqual(['email.received']);
    expect(shown.agents).toEqual([expect.objectContaining({ id: OURS, senders: ['*'], receive: true })]);
    const listed = (await (await call('GET', '/api/connectors')).json()) as { connectors: View[] };
    expect(listed.connectors[0]?.events).toEqual(['email.received']);
  });

  test('an admin sets who can write and Receive messages, one or both at a time', async () => {
    const created = await mailConnector();
    const path = `/api/connectors/${created.id}/agents/${OURS}/mail`;
    const people = await call('PUT', path, { senders: ['Lisa@Anderra.ch', '@MCIGROUP.ch'] });
    expect(people.status).toBe(200);
    expect((await view(people)).agents[0]).toMatchObject({ senders: ['lisa@anderra.ch', '@mcigroup.ch'], receive: true });
    const off = await call('PUT', path, { receive: false });
    expect((await view(off)).agents[0]).toMatchObject({ senders: ['lisa@anderra.ch', '@mcigroup.ch'], receive: false });
    const both = await call('PUT', path, { senders: [], receive: true });
    expect((await view(both)).agents[0]).toMatchObject({ senders: ['*'], receive: true });
    const [stored] = await held.db.select().from(connectorAgents).where(eq(connectorAgents.agent, OURS));
    expect(stored).toMatchObject({ senders: '["*"]', receive: true });
    await call('PUT', `/api/connectors/${created.id}/agents/${OURS}`, { readOnly: true });
    expect((await view(await call('GET', `/api/connectors/${created.id}`))).agents[0]).toMatchObject({ senders: ['*'], receive: true });
  });

  test('a bad body is refused with a sentence, a member is refused, and nothing outside the organization changes', async () => {
    const created = await mailConnector();
    const path = `/api/connectors/${created.id}/agents/${OURS}/mail`;
    const bad = await call('PUT', path, { senders: ['Lisa'] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('is not an email address or a domain');
    expect((await call('PUT', path, {})).status).toBe(400);
    expect((await call('PUT', path, { receive: 'no' })).status).toBe(400);
    expect((await call('PUT', path, { senders: ['a@b.com'], other: 1 })).status).toBe(400);
    expect((await call('PUT', path, { receive: false }, await auth(TEST_OWNER, 'member'))).status).toBe(403);
    expect((await call('PUT', `/api/connectors/${created.id}/agents/${THEIRS}/mail`, { receive: false })).status).toBe(404);
    expect((await call('PUT', path, { receive: false }, await auth(TEST_STRANGER))).status).toBe(404);
    expect((await call('GET', path)).status).toBe(405);
    const [stored] = await held.db.select().from(connectorAgents).where(eq(connectorAgents.agent, OURS));
    expect(stored).toMatchObject({ senders: '["*"]', receive: true });
  });
});
