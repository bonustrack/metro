import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { log } from '@metro-labs/core/log';
import type { McpCallRow } from '@metro-labs/connectors/db/mcp-calls';
import { connectors, mcpCalls } from '@metro-labs/connectors/db/schema';
import { addConnector, assign, callTool, enrollAgent, headerSecret, PGLITE_START_MS, rewrite, startApp, testDb, texts, type TestAgent, type TestApp, type TestDb } from './helpers.ts';
import { startVendor, type FakeVendor } from './vendor.ts';

let held: TestDb;
let vendor: FakeVendor;
let app: TestApp;
let agent: TestAgent;

const until = async (done: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 200 && !(await done()); i += 1) await Bun.sleep(10);
};

const rows = async (): Promise<McpCallRow[]> => held.db.select().from(mcpCalls);

const settled = async (count: number): Promise<McpCallRow[]> => {
  await until(async () => (await rows()).length >= count);
  return (await rows()).sort((a, b) => (a.tool < b.tool ? -1 : 1));
};

const run = (calls: unknown[]) => callTool(app, agent.token, 'tool_call', { calls });

beforeAll(async () => {
  held = await testDb();
  vendor = await startVendor();
}, PGLITE_START_MS);
beforeEach(async () => {
  await held.reset();
  vendor.calls.length = 0;
  vendor.state.answerOrder = [];
  agent = await enrollAgent(held.db, 'agent000001');
  await addConnector(held.db, 'conn0000001', 'Notion', headerSecret());
  await assign(held.db, 'conn0000001', agent.row.agent);
  app = await startApp(held.db, rewrite(vendor.base));
});
afterEach(async () => { await app.close(); });
afterAll(async () => {
  await vendor.close();
  await held.close();
});

describe('every tool_call call is recorded', () => {
  test('calls run in parallel write one row each, with who, what, the outcome and the time, never the arguments or the result', async () => {
    const result = await run([{ tool: 'notion.search', arguments: { query: 'secret roadmap' } }, { tool: 'notion.update_page', arguments: { page_id: 'page-of-payroll' } }]);
    expect(result.isError).toBeUndefined();
    const written = await settled(2);
    const who = { owner: agent.row.owner, agent: 'agent000001', agentName: 'agent000001.tail0000.ts.net', connector: 'conn0000001', connectorKey: 'notion', connectorName: 'Notion', outcome: 'ok' };
    expect(written.map((row) => ({ owner: row.owner, agent: row.agent, agentName: row.agentName, connector: row.connector, connectorKey: row.connectorKey, connectorName: row.connectorName, tool: row.tool, outcome: row.outcome }))).toEqual([
      { ...who, tool: 'search' },
      { ...who, tool: 'update_page' },
    ]);
    expect(written.every((row) => row.ms >= 0 && row.at > 0 && row.id.length === 11)).toBe(true);
    expect(new Set(written.map((row) => row.id)).size).toBe(2);
    const stored = JSON.stringify(written);
    for (const word of ['secret roadmap', 'page-of-payroll', 'ran with']) expect(stored).not.toContain(word);
  });

  test('a blocked tool, a call waiting for approval and an unknown connector are recorded with their outcome', async () => {
    await held.db.update(connectors).set({ policy: JSON.stringify({ tools: { delete_page: 'deny', update_page: 'ask' } }) }).where(eq(connectors.id, 'conn0000001'));
    await run([{ tool: 'notion.delete_page', arguments: {} }, { tool: 'notion.update_page', arguments: { page_id: 'ARGUMENT_MARKER_P1' } }, { tool: 'jira.search', arguments: {} }]);
    const written = await settled(3);
    expect(written.map((row) => [row.connector, row.connectorKey, row.connectorName, row.tool, row.outcome])).toEqual([
      ['conn0000001', 'notion', 'Notion', 'delete_page', 'blocked'],
      [null, 'jira', null, 'search', 'not_found'],
      ['conn0000001', 'notion', 'Notion', 'update_page', 'needs_approval'],
    ]);
    expect(JSON.stringify(written)).not.toContain('ARGUMENT_MARKER_P1');
  });

  test('a vendor error is recorded as one', async () => {
    vendor.state.answer = () => ({ isError: true, content: [{ type: 'text', text: 'the page is locked' }] });
    try {
      await run([{ tool: 'notion.search', arguments: { query: 'x' } }]);
      const [written] = await settled(1);
      expect(written?.outcome).toBe('vendor_error');
      expect(JSON.stringify(written)).not.toContain('locked');
    } finally {
      vendor.state.answer = (tool, args) => ({ content: [{ type: 'text', text: `${tool} ran with ${JSON.stringify(args)}` }] });
    }
  });
});

describe('recording never gets in the way of a call', () => {
  test('without the table the call still answers, and the missing table is logged once', async () => {
    const warn = spyOn(log, 'warn');
    await held.client.exec('ALTER TABLE "mcp_calls" RENAME TO "mcp_calls_away"');
    try {
      const first = await run([{ tool: 'notion.search', arguments: { query: 'a' } }, { tool: 'notion.update_page', arguments: { page_id: 'b' } }]);
      expect(texts(first)).toEqual(['[1] notion.search', 'search ran with {"query":"a"}', '[2] notion.update_page', 'update_page ran with {"page_id":"b"}']);
      const second = await run([{ tool: 'notion.search', arguments: { query: 'c' } }]);
      expect(second.isError).toBeUndefined();
      await until(() => Promise.resolve(warn.mock.calls.length > 0));
      await Bun.sleep(50);
      const lines = warn.mock.calls.filter((call) => String(call[0]).includes('mcp_calls'));
      expect(lines).toHaveLength(1);
    } finally {
      await held.client.exec('ALTER TABLE "mcp_calls_away" RENAME TO "mcp_calls"');
      warn.mockRestore();
    }
    const info = spyOn(log, 'info');
    try {
      await run([{ tool: 'notion.search', arguments: { query: 'd' } }]);
      await settled(1);
      await until(() => Promise.resolve(info.mock.calls.some((call) => call[0] === 'mcp: recording calls again')));
      expect(info.mock.calls.some((call) => call[0] === 'mcp: recording calls again')).toBe(true);
    } finally {
      info.mockRestore();
    }
  });
});
