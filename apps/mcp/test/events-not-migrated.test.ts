import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { MCP_PATHS, mcpInboxOf } from '@metro-labs/http/mcp-server-protocol';
import { newWebhookSecret, webhookSignature } from '@metro-labs/http/standard-webhooks';
import { isNotMigrated } from '@metro-labs/connectors/db/errors';
import { pruneEventsOnce } from '../src/prune.ts';
import { reconcileSubscriptions, startSubscriptions } from '../src/subscriptions.ts';
import { addConnector, callTool, enrollAgent, headerSecret, PGLITE_START_MS, rewrite, signed, startApp, testDb, texts, type TestAgent, type TestApp, type TestDb } from './helpers.ts';
import { startVendor, type FakeVendor } from './vendor.ts';

const UNDO_0026 = [
  'DROP TABLE "connector_events"',
  'DROP TABLE "connector_subscriptions"',
  'ALTER TABLE "connector_agents" DROP COLUMN "events", DROP COLUMN "senders"',
  'ALTER TABLE "connector_tools" DROP COLUMN "events"',
  'ALTER TABLE "mcp_calls" DROP CONSTRAINT "mcp_calls_kind_check"',
  'ALTER TABLE "mcp_calls" DROP COLUMN "kind"',
];

let held: TestDb;
let app: TestApp;
let vendor: FakeVendor;
let agent: TestAgent;

beforeAll(async () => {
  held = await testDb();
  for (const statement of UNDO_0026) await held.client.exec(statement);
  vendor = await startVendor();
  agent = await enrollAgent(held.db, 'agent000001');
  await addConnector(held.db, 'conn0000001', 'Notion', headerSecret());
  await held.db.execute(sql`insert into connector_agents (connector, agent, policy, created_by, created_at) values ('conn0000001', 'agent000001', null, 'user_01TEST', '2026-11-10T00:00:00.000Z')`);
  app = await startApp(held.db, rewrite(vendor.base), { inboxHoldMs: 150, inboxCheckMs: 50, approvalHoldMs: 100, approvalPollMs: 30 });
}, PGLITE_START_MS);

afterAll(async () => {
  await app.close();
  await vendor.close();
  await held.close();
});

describe('mcp.metro.box started before api.metro.box migrated', () => {
  test('still finds and calls tools', async () => {
    const found = await callTool(app, agent.token, 'tool_search', { query: 'select:notion.search' });
    expect(texts(found).join('\n')).toContain('notion.search');
    const called = await callTool(app, agent.token, 'tool_call', { calls: [{ tool: 'notion.search', arguments: { query: 'roadmap' } }] });
    expect(called.isError).not.toBe(true);
    expect(texts(called).join('\n')).toContain('search ran with');
  });

  test('keeps answering approvals, and the inbox answers no events after its hold', async () => {
    const approvals = signed(agent, MCP_PATHS.approvals, {});
    expect((await fetch(`${app.base}${MCP_PATHS.approvals}`, { method: 'POST', headers: approvals.headers, body: approvals.body })).status).toBe(200);
    const inbox = signed(agent, MCP_PATHS.inbox, { settled: [{ id: 'abcdefghijk', outcome: 'delivered' }] });
    const started = Date.now();
    const res = await fetch(`${app.base}${MCP_PATHS.inbox}`, { method: 'POST', headers: inbox.headers, body: inbox.body });
    expect(res.status).toBe(200);
    expect(mcpInboxOf(await res.json())).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(130);
  });

  test('asks a delivery to come again, and the reconciler and the expiry wait without failing', async () => {
    const body = '{}';
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = { 'webhook-id': 'msg_1', 'webhook-timestamp': String(timestamp), 'webhook-signature': webhookSignature(newWebhookSecret(), 'msg_1', timestamp, body), 'x-mcp-subscription-id': 'sub_1' };
    const res = await fetch(`${app.base}/v1/events/abcdefghijk`, { method: 'POST', headers, body });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    const failure: unknown = await reconcileSubscriptions(app.deps).then(() => null, (err: unknown) => err);
    expect(isNotMigrated(failure)).toBe(true);
    const stop = startSubscriptions(app.deps, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();
    expect(await pruneEventsOnce(app.deps, () => held.db)).toBeNull();
  });
});
