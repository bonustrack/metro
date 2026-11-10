import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { MCP_PATHS, mcpMailOf } from '@metro-labs/http/mcp-server-protocol';
import { MAIL_KEEP_MS } from '@metro-labs/connectors/db/connector-inbox';
import { mcpCallStore } from '@metro-labs/connectors/db/mcp-calls';
import { saveToolListing } from '@metro-labs/connectors/db/connector-tools';
import { connectorAgents, connectorInbox, connectors, connectorSubscriptions, mcpCalls } from '@metro-labs/connectors/db/schema';
import { pruneMailOnce } from '../src/prune.ts';
import { syncSubscriptions } from '../src/subscriptions.ts';
import { addConnector, assign, enrollAgent, headerSecret, OWNER, PGLITE_START_MS, rewrite, signed, startApp, testDb, type TestAgent, type TestApp, type TestDb } from './helpers.ts';
import { mailEvent, MAIL_TOOLS, startEventsServer, type EventsServer, type Subscription } from './events-server.ts';

const CONNECTOR = 'conn0000001';
let held: TestDb;
let events: EventsServer;
let app: TestApp;
let agent: TestAgent;
let sub: Subscription;

beforeAll(async () => {
  held = await testDb();
  events = await startEventsServer();
}, PGLITE_START_MS);
beforeEach(async () => {
  await held.reset();
  events.subscribes.length = 0;
  events.verified.length = 0;
  agent = await enrollAgent(held.db, 'agent000001');
  await addConnector(held.db, CONNECTOR, 'Gmail', headerSecret('/mcp'));
  await assign(held.db, CONNECTOR, agent.row.agent);
  await saveToolListing(held.db, CONNECTOR, { tools: MAIL_TOOLS.map((tool) => ({ name: tool.name, title: tool.name, description: tool.description, readOnly: false })), icons: [], events: [{ name: 'email.received', delivery: ['webhook'] }], listedAt: Date.now(), failure: null, failedAt: 0 });
  app = await startApp(held.db, rewrite(events.base), { approvalHoldMs: 50, approvalPollMs: 10 });
  events.state.metroBase = app.base;
  await syncSubscriptions(app.deps);
  const first = events.subscribes[0];
  if (first === undefined) throw new Error('no subscription');
  sub = first;
});
afterEach(async () => { await app.close(); });
afterAll(async () => {
  await events.close();
  await held.close();
});

async function daemon(path: string, body: unknown): Promise<Record<string, unknown>> {
  const request = signed(agent, path, body);
  const res = await fetch(`${app.base}${path}`, { method: 'POST', body: request.body, headers: request.headers });
  return (await res.json()) as Record<string, unknown>;
}

const inbox = () => held.db.select().from(connectorInbox).orderBy(connectorInbox.receivedAt);
const activity = () => held.db.select().from(mcpCalls).orderBy(mcpCalls.at);
const setMail = (patch: { senders?: string; receive?: boolean }) => held.db.update(connectorAgents).set(patch).where(eq(connectorAgents.agent, agent.row.agent));

async function settled(): Promise<void> {
  for (let i = 0; i < 50 && (await activity()).length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('a delivery must be signed', () => {
  test('missing headers, a wrong secret, an old timestamp and an unknown address are refused', async () => {
    const url = new URL(sub.url.replace('https://mcp.metro.box', app.base));
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await events.deliver(sub, mailEvent('e1'), { secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}` })).status).toBe(401);
    expect((await events.deliver(sub, mailEvent('e1'), { at: Date.now() - 6 * 60_000 })).status).toBe(401);
    expect((await events.deliver({ ...sub, url: 'https://mcp.metro.box/v1/events/nosuchrow01' }, mailEvent('e1'))).status).toBe(410);
    expect((await fetch(`${app.base}/v1/events/${url.pathname.split('/').at(-1) ?? ''}`)).status).toBe(405);
    expect(await inbox()).toEqual([]);
  });

  test('a verification challenge is echoed, a gap moves the cursor, a terminated subscription is subscribed again later', async () => {
    const challenge = await events.deliver(sub, { type: 'verification', challenge: 'nonce-1' });
    expect(await challenge.json()).toEqual({ challenge: 'nonce-1' });
    expect((await events.deliver(sub, { type: 'gap', cursor: 'history-9' })).status).toBe(200);
    expect((await held.db.select().from(connectorSubscriptions))[0]?.cursor).toBe('history-9');
    expect((await events.deliver(sub, { type: 'terminated', error: { code: -32023, message: 'removed', data: { kind: 'event' } } })).status).toBe(200);
    const [ended] = await held.db.select().from(connectorSubscriptions);
    expect(ended?.serverId).toBeNull();
    expect(ended?.error).toContain('removed');
  });

  test('a mailbox that signed out is not subscribed again until the connector signs in again', async () => {
    expect((await events.deliver(sub, { type: 'terminated', error: { code: -32024, message: 'Signed out', data: { reason: 'signed_out' } } })).status).toBe(200);
    const [ended] = await held.db.select().from(connectorSubscriptions);
    expect(ended).toMatchObject({ serverId: null, error: expect.stringContaining('signed out') as unknown as string });
    await held.db.update(connectorSubscriptions).set({ errorAt: Date.now() - 60 * 60_000 });
    expect(await syncSubscriptions(app.deps)).toBe(0);
    await held.db.update(connectors).set({ authGeneration: 'generation2' }).where(eq(connectors.id, CONNECTOR));
    expect(await syncSubscriptions(app.deps)).toBe(1);
  });

  test('a verified body that is neither an event nor an envelope is refused for good', async () => {
    expect((await events.deliver(sub, ['not', 'an', 'event'], { id: 'odd' })).status).toBe(410);
  });

  test('a mail Metro cannot read is refused for good with 410', async () => {
    expect((await events.deliver(sub, mailEvent('bad', { from: { address: 'not an address' } }))).status).toBe(410);
    expect(await inbox()).toEqual([]);
  });
});

describe('a kept mail', () => {
  test('keeps a file that has no link, so the agent knows it exists', async () => {
    await events.deliver(sub, mailEvent('f1', { attachments: [{ name: 'huge.zip', mime: 'application/zip', size: 30_000_000, url: null }] }));
    const [mail] = mcpMailOf(await daemon(MCP_PATHS.approvals, { mail: true }));
    expect(mail?.attachments).toEqual([{ name: 'huge.zip', mime: 'application/zip', size: 30_000_000, url: null }]);
  });

  test('is sealed until the box takes it, reaches only a box that asks for mail, and leaves one Delivered row', async () => {
    expect((await events.deliver(sub, mailEvent('e1'))).status).toBe(200);
    const [row] = await inbox();
    expect(row?.state).toBe('waiting');
    expect(row?.mail).not.toContain('SECRET_MAIL_BODY');
    expect((await held.db.select().from(connectorSubscriptions))[0]?.cursor).toBe('c-e1');
    const [mail] = mcpMailOf(await daemon(MCP_PATHS.approvals, { mail: true }));
    expect(mail).toMatchObject({ id: row?.id, connector: CONNECTOR, key: 'gmail', name: 'Gmail', threadId: 'thread/one+1', from: { address: 'lisa@anderra.ch', name: 'Lisa Rossi' }, subject: 'Quarterly numbers', senderVerified: true });
    expect(mail?.text).toContain('SECRET_MAIL_BODY');
    expect(mail?.attachments).toEqual([{ name: 'q3.pdf', mime: 'application/pdf', size: 2048, url: 'https://files.example.com/q3.pdf?sig=abc' }]);
    expect(await daemon(MCP_PATHS.approvals, {})).toEqual({ approvals: [] });
    expect((await events.deliver(sub, mailEvent('e1'))).status).toBe(200);
    expect(await inbox()).toHaveLength(1);
    expect(await daemon(MCP_PATHS.mailTaken, { taken: [{ id: row?.id, outcome: 'delivered' }] })).toEqual({ ok: true, taken: 1 });
    expect(await daemon(MCP_PATHS.mailTaken, { taken: [{ id: row?.id, outcome: 'delivered' }] })).toEqual({ ok: true, taken: 0 });
    const [taken] = await inbox();
    expect(taken).toMatchObject({ state: 'delivered', mail: null });
    await settled();
    const rows = await activity();
    expect(rows).toEqual([expect.objectContaining({ kind: 'received', connector: CONNECTOR, connectorKey: 'gmail', connectorName: 'Gmail', tool: 'email.received', outcome: 'delivered', agent: agent.row.agent })]);
    expect(JSON.stringify(rows)).not.toMatch(/SECRET_MAIL_BODY|anderra|Quarterly/i);
  });

  test('the box confirms a paused one as dropped', async () => {
    await events.deliver(sub, mailEvent('e2'));
    const [mail] = mcpMailOf(await daemon(MCP_PATHS.approvals, { mail: true }));
    await daemon(MCP_PATHS.mailTaken, { taken: [{ id: mail?.id, outcome: 'paused' }] });
    await settled();
    expect((await activity()).map((row) => row.outcome)).toEqual(['dropped_paused']);
    expect((await inbox())[0]).toMatchObject({ state: 'dropped', mail: null });
  });

  test('one no box takes in 7 days expires with its row', async () => {
    await events.deliver(sub, mailEvent('e3'));
    await held.db.update(connectorInbox).set({ receivedAt: Date.now() - MAIL_KEEP_MS - 1 });
    expect(await pruneMailOnce(() => held.db, app.deps)).toBe(1);
    await settled();
    expect((await activity()).map((row) => row.outcome)).toEqual(['expired']);
    expect((await inbox())[0]).toMatchObject({ state: 'expired', mail: null });
  });
});

describe('who can write', () => {
  const cases: { name: string; senders: string; receive: boolean; data: Record<string, unknown>; outcome: string | null }[] = [
    { name: 'anyone, even unverified', senders: '["*"]', receive: true, data: { senderVerified: false }, outcome: null },
    { name: 'a listed domain', senders: '["@anderra.ch"]', receive: true, data: {}, outcome: null },
    { name: 'someone not listed', senders: '["bob@example.com"]', receive: true, data: {}, outcome: 'dropped_sender' },
    { name: 'a listed sender who is not verified', senders: '["lisa@anderra.ch"]', receive: true, data: { senderVerified: false }, outcome: 'dropped_unverified' },
    { name: 'anyone while Receive messages is off', senders: '["*"]', receive: false, data: {}, outcome: 'dropped_off' },
  ];
  for (const one of cases) {
    test(`${one.name}: ${one.outcome ?? 'kept'}`, async () => {
      await setMail({ senders: one.senders, receive: one.receive });
      expect((await events.deliver(sub, mailEvent('g1', one.data))).status).toBe(200);
      const [row] = await inbox();
      expect(row?.state).toBe(one.outcome === null ? 'waiting' : 'dropped');
      if (one.outcome === null) return;
      expect(row?.mail).toBeNull();
      await settled();
      expect((await activity()).map((call) => [call.kind, call.outcome, call.ms])).toEqual([['received', one.outcome, 0]]);
      expect((await events.deliver(sub, mailEvent('g1', one.data))).status).toBe(200);
      expect(await activity()).toHaveLength(1);
    });
  }

  test('a mail for an agent that lost the connector is refused for good', async () => {
    await held.db.delete(connectorAgents).where(eq(connectorAgents.agent, agent.row.agent));
    expect((await events.deliver(sub, mailEvent('g2'))).status).toBe(410);
  });
});

describe('the activity numbers', () => {
  test('received mail is listed with its kind but never counted as a call', async () => {
    await setMail({ senders: '["bob@example.com"]' });
    await events.deliver(sub, mailEvent('s1'));
    await settled();
    app.deps.calls.record({ owner: OWNER, agent: agent.row.agent }, { connector: CONNECTOR, connectorKey: 'gmail', connectorName: 'Gmail', tool: 'reply', outcome: 'ok', ms: 30, at: Date.now() });
    for (let i = 0; i < 50 && (await activity()).length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const store = mcpCallStore(() => held.db);
    expect((await store.recent(OWNER, { limit: 10 })).map((call) => call.kind).sort()).toEqual(['call', 'received']);
    const stats = await store.stats({ owner: OWNER, from: Date.now() - 60_000, to: Date.now() + 60_000, bucketMs: 60_000 });
    expect(stats.totals).toMatchObject({ total: 1, ok: 1 });
  });
});
