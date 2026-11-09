import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { isWebhookSecret } from '@metro-labs/http/standard-webhooks';
import { readToolListings, saveToolListing } from '@metro-labs/connectors/db/connector-tools';
import { agents, connectorAgents, connectors, connectorSubscriptions } from '@metro-labs/connectors/db/schema';
import { RETRY_MS, startSubscriptions, SUBSCRIPTION_TTL_MS, syncSubscriptions } from '../src/subscriptions.ts';
import { addConnector, assign, callTool, enrollAgent, headerSecret, OWNER, PGLITE_START_MS, rewrite, startApp, testDb, type TestAgent, type TestApp, type TestDb } from './helpers.ts';
import { MAIL_TOOLS, startEventsServer, type EventsServer } from './events-server.ts';

const CONNECTOR = 'conn0000001';
let held: TestDb;
let events: EventsServer;
let app: TestApp;
let agent: TestAgent;
let clock = Date.now();

beforeAll(async () => {
  held = await testDb();
  events = await startEventsServer();
}, PGLITE_START_MS);
beforeEach(async () => {
  await held.reset();
  events.subscribes.length = 0;
  events.unsubscribes.length = 0;
  events.verified.length = 0;
  events.methods.length = 0;
  Object.assign(events.state, { accepted: 'Bearer VENDOR_KEY', capability: 'experimental', grantMs: 24 * 60 * 60_000, cursor: 'history-1', verify: false, signedOut: false });
  clock = Date.now();
  agent = await enrollAgent(held.db, 'agent000001');
  await addConnector(held.db, CONNECTOR, 'Gmail', headerSecret('/mcp'));
  await assign(held.db, CONNECTOR, agent.row.agent);
  app = await startApp(held.db, rewrite(events.base), { now: () => clock });
  events.state.metroBase = app.base;
  events.state.now = () => clock;
});
afterEach(async () => { await app.close(); });
afterAll(async () => {
  await events.close();
  await held.close();
});

const listed = (connector = CONNECTOR, delivery = ['webhook']): Promise<void> =>
  saveToolListing(held.db, connector, { tools: MAIL_TOOLS.map((tool) => ({ name: tool.name, title: tool.name, description: tool.description, readOnly: tool.name === 'read' })), icons: [], events: [{ name: 'email.received', delivery }], listedAt: clock, failure: null, failedAt: 0 });

const rows = () => held.db.select().from(connectorSubscriptions).orderBy(connectorSubscriptions.agent);
const sync = () => syncSubscriptions(app.deps);

describe('what a connector lists', () => {
  for (const capability of ['experimental', 'top'] as const) {
    test(`a tool listing keeps the events a server declares under ${capability === 'top' ? 'capabilities.events' : 'capabilities.experimental.events'}`, async () => {
      events.state.capability = capability;
      await callTool(app, agent.token, 'tool_search', { query: 'reply' });
      const listing = (await readToolListings(held.db, [CONNECTOR])).get(CONNECTOR);
      expect(listing?.events).toEqual([{ name: 'email.received', delivery: ['webhook'] }, { name: 'calendar.changed', delivery: ['poll'] }]);
      expect(events.methods).toContain('events/list');
    });
  }

  test('a server that declares no events is not asked for them', async () => {
    events.state.capability = 'none';
    await callTool(app, agent.token, 'tool_search', { query: 'reply' });
    expect((await readToolListings(held.db, [CONNECTOR])).get(CONNECTOR)?.events).toEqual([]);
    expect(events.methods).not.toContain('events/list');
  });
});

describe('subscribing to mail', () => {
  test('once per agent with a server, with its own address and a fresh whsec_ secret kept sealed', async () => {
    await listed();
    const second = await enrollAgent(held.db, 'agent000002');
    await assign(held.db, CONNECTOR, second.row.agent);
    await held.db.insert(agents).values({ id: 'remote00001', owner: OWNER, kind: 'remote', host: null, addedAt: '2026-11-09T00:00:00.000Z', slug: 'laptop' });
    await assign(held.db, CONNECTOR, 'remote00001');
    expect(await sync()).toBe(2);
    const stored = await rows();
    expect(stored.map((row) => row.agent)).toEqual(['agent000001', 'agent000002']);
    expect(events.subscribes.map((sub) => sub.url).sort()).toEqual(stored.map((row) => `https://mcp.metro.box/v1/events/${row.id}`).sort());
    for (const sub of events.subscribes) {
      expect(isWebhookSecret(sub.secret)).toBe(true);
      expect(sub.ttlMs).toBe(SUBSCRIPTION_TTL_MS);
      expect(sub.cursor).toBeNull();
      expect(JSON.stringify(stored)).not.toContain(sub.secret.slice(6));
    }
    expect(new Set(events.subscribes.map((sub) => sub.secret)).size).toBe(2);
    expect(events.verified).toEqual([]);
    expect(stored.every((row) => row.serverId?.startsWith('sub_') === true && row.cursor === 'history-1' && row.refreshBefore !== null && row.error === null)).toBe(true);
    expect(await sync()).toBe(0);
    expect(events.subscribes).toHaveLength(2);
  });

  test('a server that asks for the handshake gets its challenge echoed before it answers', async () => {
    await listed();
    events.state.verify = true;
    expect(await sync()).toBe(1);
    expect(events.verified).toEqual([events.subscribes[0]?.url]);
    expect((await rows())[0]?.serverId).toStartWith('sub_');
  });

  test('a signed-out mailbox is not asked again until the connector signs in again', async () => {
    await listed();
    events.state.signedOut = true;
    await sync();
    const [paused] = await rows();
    expect(paused?.serverId).toBeNull();
    expect(paused?.error).toContain('signed out');
    clock += 2 * RETRY_MS;
    expect(await sync()).toBe(0);
    events.state.signedOut = false;
    await held.db.update(connectors).set({ authGeneration: 'generation2' }).where(eq(connectors.id, CONNECTOR));
    expect(await sync()).toBe(1);
    expect((await rows())[0]?.serverId).toStartWith('sub_');
  });

  test('a connector that only offers poll delivery, or an agent not enrolled, gets no subscription', async () => {
    await listed(CONNECTOR, ['poll']);
    expect(await sync()).toBe(0);
    await listed();
    await held.db.insert(agents).values({ id: 'agent000009', owner: OWNER, host: 'nine.tail0000.ts.net', addedAt: '2026-11-09T00:00:00.000Z', slug: 'nine' });
    await assign(held.db, CONNECTOR, 'agent000009');
    expect(await sync()).toBe(1);
    expect((await rows()).map((row) => row.agent)).toEqual(['agent000001']);
  });

  test('refreshes before refreshBefore with the stored cursor, and not before', async () => {
    await listed();
    events.state.grantMs = 60 * 60_000;
    await sync();
    events.state.cursor = 'history-2';
    clock += 20 * 60_000;
    expect(await sync()).toBe(0);
    clock += 15 * 60_000;
    expect(await sync()).toBe(1);
    expect(events.subscribes).toHaveLength(2);
    expect(events.subscribes[1]?.url).toBe(events.subscribes[0]?.url);
    expect(events.subscribes[1]?.secret).toBe(events.subscribes[0]?.secret);
    expect(events.subscribes[1]?.cursor).toBe('history-1');
    expect((await rows())[0]?.cursor).toBe('history-2');
  });

  test('a new sign-in subscribes again at the same address with a new secret', async () => {
    await listed();
    await sync();
    await held.db.update(connectors).set({ authGeneration: 'generation2' }).where(eq(connectors.id, CONNECTOR));
    expect(await sync()).toBe(1);
    expect(events.subscribes[1]?.url).toBe(events.subscribes[0]?.url);
    expect(events.subscribes[1]?.secret).not.toBe(events.subscribes[0]?.secret);
  });

  test('a failure is kept on the row and tried again after 5 minutes', async () => {
    await listed();
    events.state.accepted = 'Bearer SOMETHING_ELSE';
    await sync();
    const [failed] = await rows();
    expect(failed?.serverId).toBeNull();
    expect(failed?.error).toContain('sign');
    expect(await sync()).toBe(0);
    events.state.accepted = 'Bearer VENDOR_KEY';
    clock += RETRY_MS;
    expect(await sync()).toBe(1);
    expect((await rows())[0]?.error).toBeNull();
  });

  test('an unassigned connector is unsubscribed and its row removed; a deleted one takes its row with it', async () => {
    await listed();
    await sync();
    await held.db.delete(connectorAgents).where(eq(connectorAgents.agent, agent.row.agent));
    expect(await sync()).toBe(1);
    expect(events.unsubscribes).toEqual([events.subscribes[0]?.url]);
    expect(await rows()).toEqual([]);
    await assign(held.db, CONNECTOR, agent.row.agent);
    await sync();
    expect(await rows()).toHaveLength(1);
    await held.db.delete(connectors).where(eq(connectors.id, CONNECTOR));
    expect(await rows()).toEqual([]);
  });
});

describe('one machine at a time', () => {
  test('two machines running the loop subscribe once', async () => {
    await listed();
    const stops = [startSubscriptions(app.deps, 20), startSubscriptions(app.deps, 20)];
    for (let i = 0; i < 100 && events.subscribes.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const stop of stops) stop();
    expect(events.subscribes).toHaveLength(1);
  });

  test('the lease goes to one holder until it lapses, then the other takes over', async () => {
    const lease = app.deps.subscriptions.lease;
    expect(await lease('connector-subscriptions', 'machine-a', clock, 1000)).toBe(true);
    expect(await lease('connector-subscriptions', 'machine-b', clock + 10, 1000)).toBe(false);
    expect(await lease('connector-subscriptions', 'machine-a', clock + 20, 1000)).toBe(true);
    expect(await lease('connector-subscriptions', 'machine-b', clock + 1021, 1000)).toBe(true);
    expect(await lease('connector-subscriptions', 'machine-a', clock + 1030, 1000)).toBe(false);
  });
});
