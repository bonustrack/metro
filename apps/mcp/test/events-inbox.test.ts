import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { MCP_PATHS, mcpInboxOf, type McpConnectorEvent } from '@metro-labs/http/mcp-server-protocol';
import { EVENT_KEEP_MS, EVENT_REDELIVER_MS, EVENTS_PER_POLL } from '@metro-labs/connectors/db/connector-events';
import { connectorAgents, connectorEvents, mcpCalls } from '@metro-labs/connectors/db/schema';
import { pruneEventsOnce } from '../src/prune.ts';
import { reconcileSubscriptions } from '../src/subscriptions.ts';
import { startEventsServer, type FakeEventsServer } from './events-server.ts';
import { addConnector, assign, enrollAgent, headerSecret, PGLITE_START_MS, rewrite, signed, startApp, testDb, type TestAgent, type TestApp, type TestDb } from './helpers.ts';

const CONNECTOR = 'conn0000001';
const MAIL = 'email.received';
const START = Date.parse('2026-11-10T10:00:00.000Z');
const MARKER = 'TOP-SECRET-BODY-4711';
const HOLD_MS = 300;

let held: TestDb;
let app: TestApp;
let vendor: FakeEventsServer;
let agent: TestAgent;
let other: TestAgent;
let clock = START;

const mail = (address = 'boss@example.com'): Record<string, unknown> => ({ messageId: 'm', from: { address }, subject: 'Hello', text: MARKER, senderVerified: true });

const post = (target: TestApp, who: TestAgent, input: unknown, headers: Record<string, string> = {}): Promise<Response> => {
  const request = signed(who, MCP_PATHS.inbox, input, clock);
  return fetch(`${target.base}${MCP_PATHS.inbox}`, { method: 'POST', body: request.body, headers: { ...request.headers, ...headers } });
};

async function poll(who: TestAgent = agent, settled: { id: string; outcome: string }[] = [], target: TestApp = app): Promise<McpConnectorEvent[]> {
  const res = await post(target, who, { settled });
  expect(res.status).toBe(200);
  return mcpInboxOf(await res.json());
}

const events = () => held.db.select().from(connectorEvents).orderBy(connectorEvents.receivedAt, connectorEvents.id);

async function recorded(count: number) {
  for (let tries = 0; tries < 100; tries += 1) {
    const rows = await held.db.select().from(mcpCalls);
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return held.db.select().from(mcpCalls);
}

beforeAll(async () => { held = await testDb(); }, PGLITE_START_MS);
beforeEach(async () => {
  await held.reset();
  clock = START;
  vendor = await startEventsServer();
  vendor.state.now = () => clock;
  agent = await enrollAgent(held.db, 'agent000001');
  other = await enrollAgent(held.db, 'agent000002');
  await addConnector(held.db, CONNECTOR, 'Work mail', headerSecret());
  await assign(held.db, CONNECTOR, agent.row.agent);
  app = await startApp(held.db, rewrite(vendor.base), { now: () => clock, inboxHoldMs: HOLD_MS, inboxCheckMs: 50 });
  vendor.state.metro = app.base;
  await held.db.update(connectorAgents).set({ events: JSON.stringify([MAIL]) }).where(and(eq(connectorAgents.connector, CONNECTOR), eq(connectorAgents.agent, agent.row.agent)));
  await reconcileSubscriptions(app.deps);
});
afterEach(async () => {
  await app.close();
  await vendor.close();
});
afterAll(async () => { await held.close(); });

describe('POST /v1/inbox', () => {
  test('is signed with the agent key like the other agent routes', async () => {
    expect((await fetch(`${app.base}${MCP_PATHS.inbox}`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await post(app, agent, {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(`${app.base}${MCP_PATHS.inbox}`)).status).toBe(405);
    const request = signed(agent, MCP_PATHS.inbox, {}, clock);
    expect((await fetch(`${app.base}${MCP_PATHS.inbox}`, { method: 'POST', headers: request.headers, body: request.body })).status).toBe(200);
    expect((await fetch(`${app.base}${MCP_PATHS.inbox}`, { method: 'POST', headers: request.headers, body: request.body })).status).toBe(401);
    for (const bad of [{ settled: 'all' }, { settled: [{ id: 'short', outcome: 'delivered' }] }, { settled: [{ id: 'abcdefghijk', outcome: 'lost' }] }, { settled: Array.from({ length: 101 }, () => ({ id: 'abcdefghijk', outcome: 'delivered' })) }])
      expect((await post(app, agent, bad)).status).toBe(400);
  });

  test('hands the agent its event with the connector, the sender Metro read and the data as it came', async () => {
    const at = new Date(clock - 5000).toISOString();
    await vendor.deliver(vendor.only(), { eventId: 'm1', data: mail(), timestamp: at });
    const row = (await events())[0];
    expect(await poll()).toEqual([{ id: row?.id ?? '', connector: { id: CONNECTOR, key: 'work-mail', name: 'Work mail' }, event: MAIL, timestamp: at, kind: 'event', eventId: 'm1', data: mail(), sender: 'boss@example.com', senderVerified: true }]);
    expect(await poll(other)).toEqual([]);
  });

  test('sends it again after a minute until the box settles it, and delivered is one activity row without content', async () => {
    await vendor.deliver(vendor.only(), { eventId: 'm1', data: mail() });
    const first = await poll();
    expect(first).toHaveLength(1);
    expect(await poll()).toEqual([]);
    clock += EVENT_REDELIVER_MS + 1;
    expect((await poll()).map((event) => event.id)).toEqual(first.map((event) => event.id));
    expect(await held.db.select().from(mcpCalls)).toEqual([]);
    clock += 4000;
    expect(await poll(agent, [{ id: first[0]?.id ?? '', outcome: 'delivered' }])).toEqual([]);
    expect((await events())[0]).toMatchObject({ state: 'delivered', body: null, settledAt: clock });
    const calls = await recorded(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'event', agent: agent.row.agent, connector: CONNECTOR, connectorKey: 'work-mail', connectorName: 'Work mail', tool: MAIL, outcome: 'delivered', ms: EVENT_REDELIVER_MS + 4001, at: clock });
    expect(JSON.stringify(calls)).not.toContain(MARKER);
    expect(JSON.stringify(calls)).not.toContain('boss@example.com');
    clock += EVENT_REDELIVER_MS + 1;
    expect(await poll(agent, [{ id: first[0]?.id ?? '', outcome: 'delivered' }])).toEqual([]);
    expect(await recorded(1)).toHaveLength(1);
  });

  test('an event the box took while messages are paused is recorded as dropped, and never sent again', async () => {
    await vendor.deliver(vendor.only(), { eventId: 'm1', data: mail() });
    const first = await poll();
    expect(await poll(agent, [{ id: first[0]?.id ?? '', outcome: 'paused' }])).toEqual([]);
    expect((await events())[0]).toMatchObject({ state: 'dropped', body: null });
    expect((await recorded(1))[0]).toMatchObject({ kind: 'event', outcome: 'dropped_paused' });
    clock += EVENT_REDELIVER_MS + 1;
    expect(await poll()).toEqual([]);
  });

  test('an agent cannot settle another agent\'s event', async () => {
    await vendor.deliver(vendor.only(), { eventId: 'm1', data: mail() });
    const id = (await events())[0]?.id ?? '';
    await poll(other, [{ id, outcome: 'delivered' }]);
    expect((await events())[0]).toMatchObject({ state: 'waiting' });
  });

  test('gives at most a few events at a time, oldest first', async () => {
    for (let at = 0; at < EVENTS_PER_POLL + 2; at += 1) {
      clock += 1;
      await vendor.deliver(vendor.only(), { eventId: `m${String(at)}`, data: mail() });
    }
    const first = await poll();
    expect(first.map((event) => (event.kind === 'event' ? event.eventId : ''))).toEqual(['m0', 'm1', 'm2', 'm3']);
    const rest = await poll(agent, first.map((event) => ({ id: event.id, outcome: 'delivered' })));
    expect(rest.map((event) => (event.kind === 'event' ? event.eventId : ''))).toEqual(['m4', 'm5']);
  });

  test('a gap reaches the agent as a note and is recorded as skipped', async () => {
    await vendor.post(vendor.only(), { type: 'gap', cursor: 'cursor-fresh' });
    const got = await poll();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'gap', event: MAIL, connector: { key: 'work-mail' } });
    await poll(agent, [{ id: got[0]?.id ?? '', outcome: 'delivered' }]);
    expect((await recorded(1))[0]).toMatchObject({ kind: 'event', tool: MAIL, outcome: 'skipped' });
  });

  test('an event for a connector the agent no longer has is dropped, not delivered', async () => {
    await vendor.deliver(vendor.only(), { eventId: 'm1', data: mail() });
    await held.db.delete(connectorAgents).where(eq(connectorAgents.agent, agent.row.agent));
    expect(await poll()).toEqual([]);
    expect((await events())[0]).toMatchObject({ state: 'dropped', body: null });
    expect((await recorded(1))[0]).toMatchObject({ kind: 'event', outcome: 'dropped_unassigned', connectorKey: CONNECTOR, connectorName: 'Work mail' });
  });
});

describe('waiting costs almost nothing', () => {
  function counted(): { due: number; claim: number; subscribed: number } {
    const counts = { due: 0, claim: 0, subscribed: 0 };
    const store = app.deps.events;
    const { due, claim, subscribed } = store;
    store.due = (identity, now) => {
      counts.due += 1;
      return due(identity, now);
    };
    store.claim = (identity, now) => {
      counts.claim += 1;
      return claim(identity, now);
    };
    store.subscribed = (identity) => {
      counts.subscribed += 1;
      return subscribed(identity);
    };
    return counts;
  }

  test('an agent with no subscription is read once and then only held', async () => {
    const counts = counted();
    const started = Date.now();
    expect(await poll(other)).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(HOLD_MS - 20);
    expect(counts).toEqual({ due: 1, claim: 0, subscribed: 1 });
  });

  test('an agent with a subscription is read every few seconds, and nothing is written while nothing waits', async () => {
    const counts = counted();
    expect(await poll()).toEqual([]);
    expect(counts.claim).toBe(0);
    expect(counts.subscribed).toBe(1);
    expect(counts.due).toBeGreaterThanOrEqual(3);
    expect(counts.due).toBeLessThanOrEqual(8);
  });

  test('a held request answers as soon as the webhook rings on the same machine', async () => {
    const slow = await startApp(held.db, rewrite(vendor.base), { now: () => clock, inboxHoldMs: 5000, inboxCheckMs: 5000 });
    vendor.state.metro = slow.base;
    try {
      const started = Date.now();
      const waiting = poll(agent, [], slow);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await vendor.deliver(vendor.only(), { eventId: 'm1', data: mail() });
      expect(await waiting).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await slow.close();
    }
  });

  test('an event taken by the other machine is found at the next read', async () => {
    const second = await startApp(held.db, rewrite(vendor.base), { now: () => clock, inboxHoldMs: 3000, inboxCheckMs: 100 });
    try {
      const started = Date.now();
      const waiting = poll(agent, [], second);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await vendor.deliver(vendor.only(), { eventId: 'm1', data: mail() });
      expect(await waiting).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await second.close();
    }
  });

  test('before the tables exist the box gets no events, and is held, not answered in a loop', async () => {
    app.deps.events.due = () => Promise.reject(Object.assign(new Error('relation "connector_events" does not exist'), { code: '42P01' }));
    const started = Date.now();
    expect(await poll()).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(HOLD_MS - 20);
  });
});

describe('events no agent took', () => {
  test('wait seven days, are then recorded as expired, and their rows go a week later', async () => {
    await vendor.deliver(vendor.only(), { eventId: 'm1', data: mail() });
    clock += EVENT_KEEP_MS - 1000;
    expect(await pruneEventsOnce(app.deps, () => held.db)).toEqual({ expired: 0, removed: 0 });
    clock += 2000;
    expect(await pruneEventsOnce(app.deps, () => held.db)).toEqual({ expired: 1, removed: 0 });
    expect((await events())[0]).toMatchObject({ state: 'expired', body: null });
    expect((await recorded(1))[0]).toMatchObject({ kind: 'event', tool: MAIL, outcome: 'expired' });
    expect(await poll()).toEqual([]);
    clock += EVENT_KEEP_MS + 1000;
    expect(await pruneEventsOnce(app.deps, () => held.db)).toEqual({ expired: 0, removed: 1 });
    expect(await events()).toEqual([]);
  });
});
