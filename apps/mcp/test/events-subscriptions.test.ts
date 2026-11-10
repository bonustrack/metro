import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { EVENT_KEEP_MS } from '@metro-labs/connectors/db/connector-events';
import { agents, connectorAgents, connectors, connectorSubscriptions, mcpCalls } from '@metro-labs/connectors/db/schema';
import type { SubscriptionRow } from '@metro-labs/connectors/db/connector-subscriptions';
import { mcpDeps } from '../src/app.ts';
import { webhookSecretOf } from '../src/receivers.ts';
import { accessRefused, reconcileSubscriptions, RETRY_MS, SIGNED_OUT, SIGNED_OUT_RETRY_MS, SUBSCRIPTION_TTL_MS } from '../src/subscriptions.ts';
import { deadlineFetch } from '../src/vendor.ts';
import { startEventsServer, type FakeEventsServer } from './events-server.ts';
import { addConnector, APP_URL, assign, enrollAgent, headerSecret, HOST, MASTER, OWNER, PGLITE_START_MS, rewrite, startApp, testDb, type TestAgent, type TestApp, type TestDb } from './helpers.ts';

const CONNECTOR = 'conn0000001';
const MAIL = 'email.received';
const START = Date.parse('2026-11-10T10:00:00.000Z');

let held: TestDb;
let app: TestApp;
let vendor: FakeEventsServer;
let agent: TestAgent;
let clock = START;

const want = async (events: string[], who = agent.row.agent): Promise<void> => {
  await held.db.update(connectorAgents).set({ events: JSON.stringify(events) }).where(and(eq(connectorAgents.connector, CONNECTOR), eq(connectorAgents.agent, who)));
};
const rows = (): Promise<SubscriptionRow[]> => held.db.select().from(connectorSubscriptions);
const only = async (): Promise<SubscriptionRow> => {
  const all = await rows();
  if (all.length !== 1 || all[0] === undefined) throw new Error(`expected one subscription row, found ${String(all.length)}`);
  return all[0];
};
const sync = (): Promise<number> => reconcileSubscriptions(app.deps);
const calls = (method: string) => vendor.requests.filter((request) => request.method === method);
const signInAgain = async (): Promise<void> => {
  await held.db.update(connectors).set({ detail: JSON.stringify({ signedInAt: new Date(clock).toISOString() }) }).where(eq(connectors.id, CONNECTOR));
};
const mail = { from: { address: 'a@example.com' }, senderVerified: true };

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
});
afterEach(async () => {
  await app.close();
  await vendor.close();
});
afterAll(async () => { await held.close(); });

describe('subscriptions are opt-in and follow what the assignment wants', () => {
  test('nothing is asked of the connector until an event is turned on', async () => {
    expect(await sync()).toBe(0);
    expect(vendor.requests).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  test('turning an event on subscribes with Metro\'s address, a secret of its own, a day and a week of replay at most, after the handshake', async () => {
    await want([MAIL]);
    await sync();
    const row = await only();
    expect(vendor.requests.map((request) => request.method)).toEqual(['events/list', 'events/subscribe']);
    const subscribe = calls('events/subscribe')[0];
    expect(subscribe?.params).toMatchObject({ name: MAIL, arguments: {}, delivery: { mode: 'webhook', url: `https://${HOST}/v1/events/${row.id}` }, cursor: null, ttlMs: SUBSCRIPTION_TTL_MS, maxAgeMs: EVENT_KEEP_MS });
    expect(subscribe?.headers['mcp-method']).toBe('events/subscribe');
    expect(subscribe?.headers['mcp-name']).toBe(MAIL);
    expect(calls('events/list')[0]?.headers['mcp-method']).toBe('events/list');
    expect(calls('events/list')[0]?.headers['mcp-name']).toBeUndefined();
    expect(vendor.verifications).toEqual([vendor.only().id]);
    expect(row).toMatchObject({ owner: OWNER, connector: CONNECTOR, agent: agent.row.agent, event: MAIL, status: 'active', error: null, cursor: 'cursor-0', failures: 0, claimedUntil: 0, nextAt: clock + SUBSCRIPTION_TTL_MS / 2 });
    expect(JSON.parse(row.sender ?? '')).toEqual({ id: '/from/address', verified: '/senderVerified' });
    const secret = vendor.only().secret;
    expect(secret).toMatch(/^whsec_/);
    expect(row.secret).not.toContain(secret.slice(6));
    expect(webhookSecretOf(MASTER, row)).toBe(secret);
  });

  test('an event type without a declared sender is subscribed with no sender pointers', async () => {
    await want(['page.updated']);
    await sync();
    expect(await only()).toMatchObject({ event: 'page.updated', status: 'active', sender: 'null' });
  });

  test('it refreshes at half the granted time, always passing the position it kept, and never shakes hands again', async () => {
    await want([MAIL]);
    await sync();
    expect((await vendor.deliver(vendor.only(), { eventId: 'm1', data: mail, cursor: 'cursor-7' })).status).toBe(200);
    expect((await only()).cursor).toBe('cursor-7');
    clock += 60 * 60_000;
    expect(await sync()).toBe(0);
    expect(calls('events/subscribe')).toHaveLength(1);
    clock += SUBSCRIPTION_TTL_MS / 2;
    vendor.state.cursor = 'cursor-9';
    const before = vendor.only().secret;
    expect(await sync()).toBe(1);
    expect(calls('events/subscribe')[1]?.params).toMatchObject({ cursor: 'cursor-7', delivery: { secret: before } });
    expect(vendor.verifications).toHaveLength(1);
    expect(await only()).toMatchObject({ status: 'active', cursor: 'cursor-9', nextAt: clock + SUBSCRIPTION_TTL_MS / 2 });
  });

  test('a position a delivery stored while the subscribe was on its way is not put back', async () => {
    await want([MAIL]);
    await sync();
    clock += SUBSCRIPTION_TTL_MS / 2;
    const release = app.deps.subscriptions.release;
    app.deps.subscriptions.release = async (id, change, cursor) => {
      expect((await vendor.deliver(vendor.only(), { eventId: 'm-late', data: mail, cursor: 'cursor-newer' })).status).toBe(200);
      await release(id, change, cursor);
    };
    await sync();
    expect(await only()).toMatchObject({ status: 'active', cursor: 'cursor-newer' });
  });

  test('a short grant is refreshed well before it ends, never sooner than a minute', async () => {
    vendor.state.grantMs = 10 * 60_000;
    await want([MAIL]);
    await sync();
    expect((await only()).nextAt).toBe(clock + 5 * 60_000);
    clock += 5 * 60_000;
    vendor.state.grantMs = 30_000;
    await sync();
    expect((await only()).nextAt).toBe(clock + 60_000);
  });

  test('switching the event off unsubscribes by name and address and removes the row', async () => {
    await want([MAIL, 'page.updated']);
    await sync();
    expect(await rows()).toHaveLength(2);
    const row = (await rows()).find((one) => one.event === MAIL);
    await want(['page.updated']);
    await sync();
    const unsubscribe = calls('events/unsubscribe')[0];
    expect(unsubscribe?.params).toEqual({ name: MAIL, arguments: {}, delivery: { url: `https://${HOST}/v1/events/${row?.id ?? ''}` } });
    expect(unsubscribe?.headers['mcp-name']).toBe(MAIL);
    expect((await rows()).map((one) => one.event)).toEqual(['page.updated']);
    expect([...vendor.subscriptions.values()].map((sub) => sub.name)).toEqual(['page.updated']);
  });

  test('taking the connector away from the agent unsubscribes too, and a row that never subscribed just goes', async () => {
    await want([MAIL]);
    await sync();
    await held.db.delete(connectorAgents).where(eq(connectorAgents.agent, agent.row.agent));
    await sync();
    expect(calls('events/unsubscribe')).toHaveLength(1);
    expect(await rows()).toEqual([]);
    await assign(held.db, CONNECTOR, agent.row.agent);
    vendor.state.signedOut = true;
    await want([MAIL]);
    await sync();
    await want([]);
    await sync();
    expect(calls('events/unsubscribe')).toHaveLength(1);
    expect(await rows()).toEqual([]);
  });

  test('an agent without a server is never subscribed', async () => {
    await held.db.insert(agents).values({ id: 'agent000009', owner: OWNER, kind: 'remote', host: null, addedAt: '2026-11-10T00:00:00.000Z', slug: 'laptop' });
    await assign(held.db, CONNECTOR, 'agent000009');
    await want([MAIL], 'agent000009');
    expect(await sync()).toBe(0);
    expect(vendor.requests).toEqual([]);
  });
});

describe('a new sign-in', () => {
  test('gets a new secret, and deliveries signed with the old one alone stop verifying', async () => {
    await want([MAIL]);
    await sync();
    const first = { ...vendor.only() };
    clock += 60_000;
    await signInAgain();
    expect(await sync()).toBe(1);
    const second = vendor.only();
    expect(second.secret).not.toBe(first.secret);
    expect(calls('events/subscribe')[1]?.params).toMatchObject({ delivery: { secret: second.secret }, cursor: 'cursor-0' });
    expect(webhookSecretOf(MASTER, await only())).toBe(second.secret);
    const event = { eventId: 'm2', data: mail };
    expect((await vendor.deliver(second, event, { secrets: [first.secret] })).status).toBe(401);
    expect((await vendor.deliver(second, event, { secrets: [first.secret, second.secret] })).status).toBe(200);
  });

  test('as another account gives another id at the server, and the handshake still answers', async () => {
    await want([MAIL]);
    await sync();
    const before = vendor.only().id;
    vendor.state.principal = 'mailbox-2';
    clock += 60_000;
    await signInAgain();
    await sync();
    expect((await only()).status).toBe('active');
    expect(vendor.verifications).toHaveLength(2);
    expect(vendor.verifications[1]).not.toBe(before);
  });

  test('a machine that stops right after changing the secret leaves the row due at once', async () => {
    await want([MAIL]);
    await sync();
    clock += 60_000;
    await signInAgain();
    const release = app.deps.subscriptions.release;
    app.deps.subscriptions.release = () => Promise.reject(new Error('the machine stopped'));
    await sync();
    app.deps.subscriptions.release = release;
    const stuck = await only();
    expect(stuck).toMatchObject({ status: 'pending', nextAt: clock });
    clock += 2 * 60_000;
    expect(await sync()).toBe(1);
    expect((await only()).status).toBe('active');
    expect((await vendor.deliver(vendor.only(), { eventId: 'm3', data: mail })).status).toBe(200);
  });
});

describe('when the connector cannot subscribe', () => {
  test('signed out upstream: it waits for a new sign-in, trying once a day at most', async () => {
    vendor.state.signedOut = true;
    await want([MAIL]);
    await sync();
    expect(await only()).toMatchObject({ status: 'signed_out', error: SIGNED_OUT, sender: null, nextAt: clock + SIGNED_OUT_RETRY_MS });
    clock += 60 * 60_000;
    expect(await sync()).toBe(0);
    expect(calls('events/subscribe')).toHaveLength(1);
    vendor.state.signedOut = false;
    await signInAgain();
    expect(await sync()).toBe(1);
    expect(await only()).toMatchObject({ status: 'active', error: null, failures: 0 });
  });

  test('Forbidden for another reason also waits for a new sign-in, and says the account may not receive it', async () => {
    vendor.state.refuse = () => ({ code: -32024, message: 'Forbidden' });
    await want([MAIL]);
    await sync();
    expect(await only()).toMatchObject({ status: 'signed_out', error: accessRefused(MAIL), nextAt: clock + SIGNED_OUT_RETRY_MS });
  });

  test('another refusal is an error with the server\'s own words once, cut short and without the secret', async () => {
    vendor.state.refuse = (params) => ({ code: -32602, message: `bad secret ${String((params.delivery as { secret?: string }).secret)} ${'x'.repeat(500)}` });
    await want([MAIL]);
    await sync();
    const row = await only();
    expect(row.status).toBe('error');
    expect(row.error?.startsWith('The connector refused the subscription: bad secret [redacted] xxx')).toBe(true);
    expect(row.error?.length).toBeLessThan(250);
    expect(row.error).not.toContain('whsec_');
  });

  test('a full connector and one that checked Metro\'s address too often each get their own sentence', async () => {
    vendor.state.refuse = () => ({ code: -32025, message: 'ResourceExhausted', data: { limit: 'subscriptions', max: 20 } });
    await want([MAIL]);
    await sync();
    expect((await only()).error).toBe('The connector has no room for another subscription right now. Metro tries again.');
    vendor.state.refuse = () => ({ code: -32025, message: 'ResourceExhausted', data: { limit: 'verifications', max: 10 } });
    clock += RETRY_MS;
    await sync();
    expect((await only()).error).toBe('The connector is checking Metro\'s address too often. Metro tries again in a few minutes.');
  });

  test('a credential the connector refuses reads as signed out', async () => {
    vendor.state.accepted = 'Bearer SOMETHING_ELSE';
    await want([MAIL]);
    await sync();
    expect(await only()).toMatchObject({ status: 'signed_out', error: SIGNED_OUT });
    clock += SIGNED_OUT_RETRY_MS;
    vendor.state.accepted = 'Bearer VENDOR_KEY';
    await sync();
    expect((await only()).status).toBe('active');
  });

  test('a server that does not declare the extension gets no events request at all', async () => {
    vendor.state.declares = false;
    await want([MAIL]);
    await sync();
    expect(vendor.requests).toEqual([]);
    expect(await only()).toMatchObject({ status: 'error', error: 'This connector does not offer events.', nextAt: clock + RETRY_MS });
  });

  test('an event the server no longer lists is an error that is tried again more and more slowly', async () => {
    await want(['gone.event']);
    await sync();
    expect(await only()).toMatchObject({ status: 'error', error: 'This connector no longer offers gone.event.', failures: 1, nextAt: clock + RETRY_MS });
    expect(calls('events/subscribe')).toEqual([]);
    clock += RETRY_MS;
    await sync();
    expect(await only()).toMatchObject({ failures: 2, nextAt: clock + 2 * RETRY_MS });
  });

  test('an address the connector cannot reach is named by its category only', async () => {
    vendor.state.metro = 'http://127.0.0.1:9';
    await want([MAIL]);
    await sync();
    expect(await only()).toMatchObject({ status: 'error', error: 'The connector could not reach Metro to deliver events (connection_refused). Metro tries again.' });
    expect(vendor.subscriptions.size).toBe(0);
  });

  test('a failure after the connector said yes does not read as a refusal: the row stays claimed and is done again', async () => {
    await want([MAIL]);
    const release = app.deps.subscriptions.release;
    app.deps.subscriptions.release = () => Promise.reject(new Error('database is away'));
    await sync();
    app.deps.subscriptions.release = release;
    expect(await only()).toMatchObject({ status: 'pending', error: null });
    clock += 2 * 60_000;
    await sync();
    expect((await only()).status).toBe('active');
  });
});

describe('two machines', () => {
  test('one deadline covers every request of a step, so a slow connector cannot outlast the claim', async () => {
    let asked = 0;
    const silent = (_url: string, init?: RequestInit): Promise<Response> => {
      asked += 1;
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted === true) reject(new Error('aborted before the request'));
        else signal?.addEventListener('abort', () => { reject(new Error('aborted while waiting')); });
      });
    };
    const bounded = deadlineFetch(silent, 40);
    const started = performance.now();
    expect(await bounded('https://slow.example/').catch((err: unknown) => String(err))).toBe('Error: aborted while waiting');
    expect(await bounded('https://slow.example/').catch((err: unknown) => String(err))).toBe('Error: aborted before the request');
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(asked).toBe(2);
  });

  test('claim each row, so one of them subscribes', async () => {
    await want([MAIL]);
    const other = mcpDeps({ key: MASTER, db: () => held.db, publicHost: HOST, appUrl: APP_URL, fetch: rewrite(vendor.base), callFetch: rewrite(vendor.base), now: () => clock });
    await Promise.all([reconcileSubscriptions(app.deps), reconcileSubscriptions(other)]);
    await Promise.all([reconcileSubscriptions(app.deps), reconcileSubscriptions(other)]);
    expect(await rows()).toHaveLength(1);
    expect(calls('events/subscribe')).toHaveLength(1);
    expect((await only()).status).toBe('active');
  });

  test('a claim left by a machine that died is taken over after two minutes', async () => {
    await want([MAIL]);
    await sync();
    const row = await only();
    await held.db.update(connectorSubscriptions).set({ nextAt: clock, claimedUntil: clock + 2 * 60_000 }).where(eq(connectorSubscriptions.id, row.id));
    expect(await sync()).toBe(0);
    clock += 2 * 60_000;
    expect(await sync()).toBe(1);
    expect(calls('events/subscribe')).toHaveLength(2);
  });
});

describe('a position the connector no longer knows', () => {
  test('on a refresh, the fresh position is kept and the skip is one activity row', async () => {
    await want([MAIL]);
    await sync();
    clock += SUBSCRIPTION_TTL_MS / 2;
    vendor.state.truncated = true;
    vendor.state.cursor = 'cursor-fresh';
    await sync();
    expect((await only()).cursor).toBe('cursor-fresh');
    for (let tries = 0; tries < 100 && (await held.db.select().from(mcpCalls)).length === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await held.db.select().from(mcpCalls)).toMatchObject([{ kind: 'event', tool: MAIL, outcome: 'skipped', connector: CONNECTOR, agent: agent.row.agent }]);
  });
});
