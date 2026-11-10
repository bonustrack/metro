import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { MCP_RECEIVER_PATH } from '@metro-labs/http/mcp-server-protocol';
import { newWebhookSecret, webhookSignature } from '@metro-labs/http/standard-webhooks';
import { connectorAgents, connectorEvents, connectorSubscriptions, mcpCalls } from '@metro-labs/connectors/db/schema';
import type { SubscriptionRow } from '@metro-labs/connectors/db/connector-subscriptions';
import { connect } from 'node:net';
import { ACCESS_LOST, reconcileSubscriptions, RETRY_MS } from '../src/subscriptions.ts';
import { startEventsServer, type FakeEventsServer } from './events-server.ts';
import { addConnector, assign, enrollAgent, headerSecret, PGLITE_START_MS, rewrite, startApp, testDb, type TestAgent, type TestApp, type TestDb } from './helpers.ts';

const CONNECTOR = 'conn0000001';
const MAIL = 'email.received';
const START = Date.parse('2026-11-10T10:00:00.000Z');
const MARKER = 'TOP-SECRET-BODY-4711';

let held: TestDb;
let app: TestApp;
let vendor: FakeEventsServer;
let agent: TestAgent;
let clock = START;
let finds = 0;

const mail = (address: string, verified: unknown = true): Record<string, unknown> => ({ messageId: 'm', from: { address, name: 'Someone' }, subject: 'Hello', text: MARKER, ...(verified === null ? {} : { senderVerified: verified }) });

const want = async (events: string[], senders: string[] = ['*'], who = agent.row.agent): Promise<void> => {
  await held.db.update(connectorAgents).set({ events: JSON.stringify(events), senders: JSON.stringify(senders) }).where(and(eq(connectorAgents.connector, CONNECTOR), eq(connectorAgents.agent, who)));
};
const kept = () => held.db.select().from(connectorEvents).orderBy(connectorEvents.receivedAt, connectorEvents.id);
const recorded = async (count: number) => {
  for (let tries = 0; tries < 100; tries += 1) {
    const rows = await held.db.select().from(mcpCalls);
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return held.db.select().from(mcpCalls);
};
const row = async (): Promise<SubscriptionRow> => {
  const rows = await held.db.select().from(connectorSubscriptions);
  if (rows[0] === undefined) throw new Error('no subscription row');
  return rows[0];
};
const address = (id: string): string => `${app.base}/v1/events/${id}`;

function signedHeaders(secret: string, body: string, patch: Record<string, string | undefined> = {}): Record<string, string> {
  const id = 'msg_test_1';
  const timestamp = Math.floor(clock / 1000);
  const headers: Record<string, string | undefined> = { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': webhookSignature(secret, id, timestamp, body), 'x-mcp-subscription-id': 'sub_x', ...patch };
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

beforeAll(async () => { held = await testDb(); }, PGLITE_START_MS);
beforeEach(async () => {
  await held.reset();
  clock = START;
  vendor = await startEventsServer();
  vendor.state.now = () => clock;
  agent = await enrollAgent(held.db, 'agent000001');
  await addConnector(held.db, CONNECTOR, 'Work mail', headerSecret());
  await assign(held.db, CONNECTOR, agent.row.agent);
  app = await startApp(held.db, rewrite(vendor.base), { now: () => clock });
  vendor.state.metro = app.base;
  await want([MAIL]);
  await reconcileSubscriptions(app.deps);
  const store = app.deps.subscriptions;
  const find = store.find;
  finds = 0;
  store.find = (id) => {
    finds += 1;
    return find(id);
  };
});
afterEach(async () => {
  await app.close();
  await vendor.close();
});
afterAll(async () => { await held.close(); });

describe('refusing a bad request is cheap', () => {
  test('the well-known document names the receiver prefix', async () => {
    const res = await fetch(`${app.base}${MCP_RECEIVER_PATH}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ receivers: ['/v1/events/'] });
    expect((await fetch(`${app.base}${MCP_RECEIVER_PATH}`, { method: 'POST' })).status).toBe(405);
  });

  test('a malformed address, a wrong method, missing or malformed headers, a stale time and an oversize body never read the database', async () => {
    const sub = await row();
    const secret = vendor.only().secret;
    const body = JSON.stringify({ eventId: 'm1', name: MAIL, timestamp: new Date(clock).toISOString(), data: mail('a@example.com') });
    const post = (url: string, headers: Record<string, string>, text = body): Promise<Response> => fetch(url, { method: 'POST', headers, body: text });
    expect((await post(address('short'), signedHeaders(secret, body))).status).toBe(410);
    expect((await post(`${address(sub.id)}/more`, signedHeaders(secret, body))).status).toBe(410);
    expect((await fetch(address(sub.id))).status).toBe(405);
    for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-mcp-subscription-id']) expect((await post(address(sub.id), signedHeaders(secret, body, { [name]: undefined }))).status).toBe(401);
    expect((await post(address(sub.id), signedHeaders(secret, body, { 'webhook-id': 'msg.with.dots' }))).status).toBe(401);
    expect((await post(address(sub.id), signedHeaders(secret, body, { 'webhook-timestamp': 'soon' }))).status).toBe(401);
    for (const skew of [-6 * 60, 6 * 60]) {
      const timestamp = Math.floor(clock / 1000) + skew;
      expect((await post(address(sub.id), signedHeaders(secret, body, { 'webhook-timestamp': String(timestamp), 'webhook-signature': webhookSignature(secret, 'msg_test_1', timestamp, body) }))).status).toBe(401);
    }
    const large = JSON.stringify({ eventId: 'big', name: MAIL, timestamp: new Date(clock).toISOString(), data: { text: 'x'.repeat(257 * 1024) } });
    expect((await post(address(sub.id), signedHeaders(secret, large), large)).status).toBe(413);
    expect(finds).toBe(0);
    expect(await kept()).toEqual([]);
  });

  test('an unknown address is 410, and a flood of them is bounded: after the burst they get 503 with no read', async () => {
    const body = '{}';
    const statuses: number[] = [];
    for (let at = 0; at < 40; at += 1) statuses.push((await fetch(address(`unknown${String(at).padStart(4, '0')}`), { method: 'POST', headers: signedHeaders(newWebhookSecret(), body), body })).status);
    expect(statuses.slice(0, 30).every((status) => status === 410)).toBe(true);
    expect(statuses.slice(30).every((status) => status === 503)).toBe(true);
    expect(finds).toBe(30);
    clock += 1000;
    const later = await fetch(address('unknown9999'), { method: 'POST', headers: signedHeaders(newWebhookSecret(), body), body });
    expect(later.status).toBe(410);
    expect(finds).toBe(31);
    expect((await vendor.deliver(vendor.only(), { eventId: 'still-fine', data: mail('a@example.com') })).status).toBe(200);
  });

  test('a wrong signature and another subscription\'s secret are 401, nothing is kept, and re-reading the secret draws on the budget', async () => {
    const sub = vendor.only();
    const event = { eventId: 'm1', data: mail('a@example.com') };
    expect((await vendor.deliver(sub, event, { secrets: [newWebhookSecret()] })).status).toBe(401);
    expect((await vendor.deliver(sub, event, { signature: 'v1,AAAA' })).status).toBe(401);
    expect((await vendor.deliver(sub, event, { signature: 'not-a-signature' })).status).toBe(401);
    expect(await kept()).toEqual([]);
    expect(finds).toBe(3);
    for (let at = 0; at < 40; at += 1) expect((await vendor.deliver(sub, event, { signature: 'v1,AAAA' })).status).toBe(401);
    expect(finds).toBe(30);
  });

  test('slow unsigned bodies on one address hold only that address: another subscription is still served', async () => {
    const second = await enrollAgent(held.db, 'agent000002');
    await assign(held.db, CONNECTOR, second.row.agent);
    await want([MAIL], ['*'], second.row.agent);
    await reconcileSubscriptions(app.deps);
    const [mine, other] = [...vendor.subscriptions.values()];
    if (mine === undefined || other === undefined) throw new Error('expected two subscriptions');
    const target = new URL(mine.url.replace('https://mcp.metro.box', app.base));
    const head = `POST ${target.pathname} HTTP/1.1\r\nhost: ${target.host}\r\nwebhook-id: msg_slow\r\nwebhook-timestamp: ${String(Math.floor(clock / 1000))}\r\nwebhook-signature: v1,AAAA\r\nx-mcp-subscription-id: sub_x\r\ncontent-length: 1000\r\n\r\n{`;
    const sockets = Array.from({ length: 4 }, () => connect(Number(target.port), target.hostname, function send() { this.write(head); }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      expect((await vendor.deliver(mine, { eventId: 'm1', data: mail('a@example.com') })).status).toBe(503);
      expect((await vendor.deliver(other, { eventId: 'm1', data: mail('a@example.com') })).status).toBe(200);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  });
});

describe('a signed delivery', () => {
  test('answers the challenge only when the signature verifies', async () => {
    const sub = vendor.only();
    const good = await vendor.post(sub, { type: 'verification', challenge: 'nonce-123' });
    expect(good.status).toBe(200);
    expect(JSON.parse(good.body)).toEqual({ challenge: 'nonce-123' });
    const bad = await vendor.post(sub, { type: 'verification', challenge: 'nonce-456' }, { secrets: [newWebhookSecret()] });
    expect(bad.status).toBe(401);
    expect(bad.body).not.toContain('nonce-456');
  });

  test('is kept sealed until the agent takes it, and the newest position is saved', async () => {
    const posted = await vendor.deliver(vendor.only(), { eventId: 'm1', data: mail('a@example.com'), cursor: 'cursor-1' });
    expect(posted.status).toBe(200);
    const rows = await kept();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: agent.row.agent, connector: CONNECTOR, event: MAIL, eventId: 'm1', receivedAt: clock, deliveredAt: null });
    expect(rows[0]?.body).toMatch(/^v1\./);
    expect(JSON.stringify(rows)).not.toContain(MARKER);
    expect(JSON.stringify(rows)).not.toContain('a@example.com');
    expect((await row()).cursor).toBe('cursor-1');
    expect(JSON.stringify(await held.db.select().from(mcpCalls))).toBe('[]');
  });

  test('any one verifying signature in the header is enough', async () => {
    const sub = vendor.only();
    const body = JSON.stringify({ eventId: 'm1', name: MAIL, timestamp: new Date(clock).toISOString(), data: mail('a@example.com') });
    const timestamp = Math.floor(clock / 1000);
    const good = webhookSignature(sub.secret, 'msg_multi', timestamp, body);
    const other = webhookSignature(newWebhookSecret(), 'msg_multi', timestamp, body);
    expect((await vendor.post(sub, null, { raw: body, id: 'msg_multi', signature: `v1a,${'A'.repeat(86)} ${other} ${good}` })).status).toBe(200);
    expect(await kept()).toHaveLength(1);
  });

  test('a repeated event is taken once, whatever the message id, and its position is still saved', async () => {
    const sub = vendor.only();
    expect((await vendor.deliver(sub, { eventId: 'm1', data: mail('a@example.com'), cursor: 'cursor-1' }, { id: 'msg_first' })).status).toBe(200);
    clock += 30_000;
    expect((await vendor.deliver(sub, { eventId: 'm1', data: mail('a@example.com'), cursor: 'cursor-2' }, { id: 'msg_first' })).status).toBe(200);
    expect((await vendor.deliver(sub, { eventId: 'm1', data: mail('a@example.com'), cursor: 'cursor-3' }, { id: 'msg_other' })).status).toBe(200);
    expect(await kept()).toHaveLength(1);
    expect((await row()).cursor).toBe('cursor-3');
  });

  test('the same event id on another subscription is another event', async () => {
    const second = await enrollAgent(held.db, 'agent000002');
    await assign(held.db, CONNECTOR, second.row.agent);
    await want([MAIL], ['*'], second.row.agent);
    await reconcileSubscriptions(app.deps);
    for (const sub of vendor.subscriptions.values()) expect((await vendor.deliver(sub, { eventId: 'shared', data: mail('a@example.com') })).status).toBe(200);
    expect((await kept()).map((event) => event.agent).sort()).toEqual([agent.row.agent, second.row.agent]);
  });

  test('a body Metro cannot use is refused for good, and so is an event the agent no longer wants', async () => {
    const sub = vendor.only();
    const at = new Date(clock).toISOString();
    for (const raw of ['not json', '[]', '"text"', JSON.stringify({ name: MAIL, timestamp: at, data: {} }), JSON.stringify({ eventId: 'm', name: MAIL, timestamp: at, data: [] }), JSON.stringify({ eventId: 'm', name: MAIL, timestamp: 'never', data: {} }), JSON.stringify({ type: 'surprise' }), JSON.stringify({ type: 'verification' })])
      expect((await vendor.post(sub, null, { raw })).status).toBe(410);
    expect((await vendor.deliver(sub, { eventId: 'm', name: 'page.updated', data: {} })).status).toBe(410);
    await want([]);
    expect((await vendor.deliver(sub, { eventId: 'm', data: mail('a@example.com') })).status).toBe(410);
    expect(await kept()).toEqual([]);
  });

  test('a store that cannot keep the event answers 503, so the connector sends it again', async () => {
    const keep = app.deps.events.keep;
    app.deps.events.keep = () => Promise.reject(new Error('database is away'));
    expect((await vendor.deliver(vendor.only(), { eventId: 'm1', data: mail('a@example.com') })).status).toBe(503);
    app.deps.events.keep = keep;
    expect((await vendor.deliver(vendor.only(), { eventId: 'm1', data: mail('a@example.com') })).status).toBe(200);
    expect(await kept()).toHaveLength(1);
  });
});

describe('who can write', () => {
  const GATE: { name: string; senders: string[]; data: Record<string, unknown>; outcome: 'waiting' | 'dropped_sender' | 'dropped_unverified' }[] = [
    { name: 'a listed sender', senders: ['boss@example.com'], data: mail('boss@example.com'), outcome: 'waiting' },
    { name: 'a listed sender in other letters', senders: ['Boss@Example.com'], data: mail('BOSS@example.COM'), outcome: 'waiting' },
    { name: 'a sender who is not listed', senders: ['boss@example.com'], data: mail('stranger@example.com'), outcome: 'dropped_sender' },
    { name: 'a listed sender who could be forged', senders: ['boss@example.com'], data: mail('boss@example.com', false), outcome: 'dropped_unverified' },
    { name: 'a listed sender whose verified flag is missing', senders: ['boss@example.com'], data: mail('boss@example.com', null), outcome: 'dropped_unverified' },
    { name: 'a listed sender whose verified flag is not a boolean', senders: ['boss@example.com'], data: mail('boss@example.com', 'yes'), outcome: 'dropped_unverified' },
    { name: 'anyone at a listed domain', senders: ['@example.com'], data: mail('anyone@example.com'), outcome: 'waiting' },
    { name: 'a subdomain of a listed domain', senders: ['@example.com'], data: mail('anyone@mail.example.com'), outcome: 'dropped_sender' },
    { name: 'a sender that is not an address, against a domain', senders: ['@example.com'], data: mail('example.com'), outcome: 'dropped_sender' },
    { name: 'no sender in the event', senders: ['boss@example.com'], data: { subject: 'Hello', senderVerified: true }, outcome: 'dropped_sender' },
    { name: 'a sender that is not a string', senders: ['boss@example.com'], data: { from: { address: ['boss@example.com'] }, senderVerified: true }, outcome: 'dropped_sender' },
    { name: 'anyone, when the list is *', senders: ['*'], data: mail('stranger@example.com'), outcome: 'waiting' },
    { name: 'a sender who could be forged, when the list is *', senders: ['*'], data: mail('stranger@example.com', false), outcome: 'waiting' },
  ];

  for (const [at, entry] of GATE.entries()) {
    test(`${entry.name} -> ${entry.outcome}`, async () => {
      await want([MAIL], entry.senders);
      expect((await vendor.deliver(vendor.only(), { eventId: `gate-${String(at)}`, data: entry.data, cursor: 'cursor-gate' })).status).toBe(200);
      const rows = await kept();
      expect(rows).toHaveLength(1);
      expect((await row()).cursor).toBe('cursor-gate');
      if (entry.outcome === 'waiting') {
        expect(rows[0]?.body).toMatch(/^v1\./);
        expect(await held.db.select().from(mcpCalls)).toEqual([]);
        return;
      }
      expect(rows[0]).toMatchObject({ body: null, receivedAt: clock });
      const calls = await recorded(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ kind: 'event', agent: agent.row.agent, connector: CONNECTOR, connectorKey: 'work-mail', connectorName: 'Work mail', tool: MAIL, outcome: entry.outcome });
      expect(JSON.stringify(calls)).not.toContain(MARKER);
      expect(JSON.stringify(calls)).not.toContain('example.com');
    });
  }

  test('an event type that declares no sender is delivered only when anyone can write', async () => {
    await want([MAIL, 'page.updated'], ['boss@example.com']);
    await reconcileSubscriptions(app.deps);
    const page = [...vendor.subscriptions.values()].find((sub) => sub.name === 'page.updated');
    if (page === undefined) throw new Error('no page subscription');
    expect((await vendor.deliver(page, { eventId: 'p1', data: { title: 'Roadmap' } })).status).toBe(200);
    expect((await kept())[0]).toMatchObject({ event: 'page.updated', eventId: 'p1', body: null });
    await want([MAIL, 'page.updated'], ['*']);
    expect((await vendor.deliver(page, { eventId: 'p2', data: { title: 'Roadmap' } })).status).toBe(200);
    expect((await kept()).map((event) => `${event.eventId} ${event.body === null ? 'dropped' : 'waiting'}`).sort()).toEqual(['p1 dropped', 'p2 waiting']);
  });
});

describe('control envelopes', () => {
  test('a gap saves the fresh position and is one activity row; nothing waits for the agent', async () => {
    expect((await vendor.post(vendor.only(), { type: 'gap', cursor: 'cursor-fresh' })).status).toBe(200);
    expect((await row()).cursor).toBe('cursor-fresh');
    expect(await kept()).toEqual([]);
    expect(await recorded(1)).toMatchObject([{ kind: 'event', tool: MAIL, outcome: 'skipped', connector: CONNECTOR }]);
  });

  test('terminated because access was lost: the subscription waits for a new sign-in', async () => {
    expect((await vendor.post(vendor.only(), { type: 'terminated', error: { code: -32024, message: 'Forbidden', data: { reason: 'signed_out' } } })).status).toBe(200);
    expect(await row()).toMatchObject({ status: 'signed_out', error: ACCESS_LOST });
    clock += 60 * 60_000;
    vendor.requests.length = 0;
    expect(await reconcileSubscriptions(app.deps)).toBe(0);
    expect(vendor.requests).toEqual([]);
  });

  test('terminated for another reason: Metro subscribes again a minute later', async () => {
    expect((await vendor.post(vendor.only(), { type: 'terminated', error: { code: -32026, message: 'Unsupported', data: { feature: 'payloadSchema', reason: 'schema_changed' } } })).status).toBe(200);
    expect(await row()).toMatchObject({ status: 'pending', error: null, nextAt: clock + RETRY_MS });
    clock += RETRY_MS;
    vendor.requests.length = 0;
    expect(await reconcileSubscriptions(app.deps)).toBe(1);
    expect(vendor.requests.map((request) => request.method)).toEqual(['events/list', 'events/subscribe']);
    expect((await row()).status).toBe('active');
  });
});

describe('what Metro will not keep yet, or ever', () => {
  test('an event that arrives before the first subscribe answer is recorded is asked to come again, then gated with the pointers', async () => {
    const sub = await row();
    await held.db.update(connectorSubscriptions).set({ sender: null }).where(eq(connectorSubscriptions.id, sub.id));
    await want([MAIL], ['boss@example.com']);
    const early = await vendor.deliver(vendor.only(), { eventId: 'm1', data: mail('boss@example.com') });
    expect(early.status).toBe(503);
    expect(await kept()).toEqual([]);
    await held.db.update(connectorSubscriptions).set({ sender: sub.sender }).where(eq(connectorSubscriptions.id, sub.id));
    expect((await vendor.deliver(vendor.only(), { eventId: 'm1', data: mail('boss@example.com') })).status).toBe(200);
    expect((await kept())[0]?.body).toMatch(/^v1\./);
  });

  test('past a thousand events waiting for one agent, the next is asked to come again', async () => {
    const waiting = app.deps.events.waiting;
    app.deps.events.waiting = () => Promise.resolve(1000);
    const full = await vendor.deliver(vendor.only(), { eventId: 'm1', data: mail('a@example.com') });
    expect(full.status).toBe(503);
    expect(await kept()).toEqual([]);
    app.deps.events.waiting = waiting;
    expect((await vendor.deliver(vendor.only(), { eventId: 'm1', data: mail('a@example.com') })).status).toBe(200);
  });

  test('data nested too deep and an event id with a line break are refused for good, not retried for ever', async () => {
    const at = new Date(clock).toISOString();
    const deep = `{"eventId":"deep","name":"${MAIL}","timestamp":"${at}","data":${'{"a":'.repeat(40_000)}1${'}'.repeat(40_000)}}`;
    expect((await vendor.post(vendor.only(), null, { raw: deep })).status).toBe(410);
    expect((await vendor.deliver(vendor.only(), { eventId: 'bad\nid', data: mail('a@example.com') })).status).toBe(410);
    expect(await kept()).toEqual([]);
  });

  test('the address selects the subscription: the id header must be there, its value is not compared', async () => {
    expect((await vendor.deliver(vendor.only(), { eventId: 'm1', data: mail('a@example.com') }, { subscriptionId: 'sub_another_derivation' })).status).toBe(200);
    expect((await vendor.deliver(vendor.only(), { eventId: 'm2', data: mail('a@example.com') }, { omit: ['x-mcp-subscription-id'] })).status).toBe(401);
  });
});
