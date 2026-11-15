import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { APPROVAL_ID_RE } from '@metro-labs/http/approval-rules';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { agents, connectors, organizations, pushOutbox } from '@metro-labs/connectors/db/schema';
import { approvalNote } from '../src/approval-push.ts';
import { addConnector, APP_URL, assign, callTool, enrollAgent, headerSecret, OWNER, PGLITE_START_MS, rewrite, startApp, testDb, texts, type TestAgent, type TestApp, type TestDb } from './helpers.ts';
import { startVendor, type FakeVendor } from './vendor.ts';

const MARKER = 'ARGUMENT_MARKER_PAYROLL';

let held: TestDb;
let vendor: FakeVendor;
let app: TestApp;
let agent: TestAgent;
let reached: string[] = [];

const until = async (done: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 200 && !(await done()); i += 1) await Bun.sleep(10);
};

const ask = (args: Record<string, unknown>) => callTool(app, agent.token, 'tool_call', { calls: [{ tool: 'notion.update_page', arguments: args }] });
const approvalOf = (text: string): string => /\(approval ([a-km-z]{5})\)/.exec(text)?.[1] ?? '';
const queued = () => held.db.select().from(pushOutbox).orderBy(pushOutbox.createdAt, pushOutbox.approval);

beforeAll(async () => {
  held = await testDb();
  vendor = await startVendor();
}, PGLITE_START_MS);

beforeEach(async () => {
  await held.reset();
  reached = [];
  agent = await enrollAgent(held.db, 'agent000001');
  await held.db.update(agents).set({ name: 'Emma' }).where(eq(agents.id, 'agent000001'));
  await addConnector(held.db, 'conn0000001', 'Notion', headerSecret());
  await held.db.update(connectors).set({ policy: JSON.stringify({ tools: { update_page: 'ask' } }) }).where(eq(connectors.id, 'conn0000001'));
  await assign(held.db, 'conn0000001', agent.row.agent);
  const vendorFetch = rewrite(vendor.base);
  const watched: FetchLike = (url, init) => {
    reached.push(url);
    return vendorFetch(url, init);
  };
  app = await startApp(held.db, watched);
});

afterEach(async () => { await app.close(); });
afterAll(async () => {
  await vendor.close();
  await held.close();
});

describe('a new approval request is queued for the phones once', () => {
  test('the queued notification names the agent, the tool and the connector, links to the approval page, and carries no argument', async () => {
    const id = approvalOf(texts(await ask({ page_id: MARKER })).join('\n'));
    expect(id).toMatch(APPROVAL_ID_RE);
    await until(async () => (await queued()).length > 0);
    const rows = await queued();
    expect(rows.map((row) => ({ owner: row.owner, agent: row.agent, approval: row.approval, title: row.title, body: row.body, url: row.url, sentAt: row.sentAt, attempts: row.attempts }))).toEqual([
      { owner: OWNER, agent: 'agent000001', approval: id, title: 'Emma needs your approval', body: 'Update page on Notion', url: `https://metro.box/#/${OWNER}/agent000001/approvals/${id}`, sentAt: null, attempts: 0 },
    ]);
    expect(JSON.stringify(rows)).not.toContain(MARKER);
  });

  test('the same call asked again reuses its approval and queues nothing more; another call queues its own', async () => {
    const first = approvalOf(texts(await ask({ page_id: 'one' })).join('\n'));
    await until(async () => (await queued()).length > 0);
    expect(approvalOf(texts(await ask({ page_id: 'one' })).join('\n'))).toBe(first);
    const other = approvalOf(texts(await ask({ page_id: 'two' })).join('\n'));
    expect(other).not.toBe(first);
    await until(async () => (await queued()).length > 1);
    await Bun.sleep(50);
    expect((await queued()).map((row) => row.approval).sort()).toEqual([first, other].sort());
  });

  test('mcp.metro.box itself never calls WorkOS or Expo: it only writes the row', async () => {
    await ask({ page_id: 'three' });
    await until(async () => (await queued()).length > 0);
    expect(reached.every((url) => url.startsWith('https://vendor.example.com'))).toBe(true);
    expect(reached.some((url) => url.includes('workos') || url.includes('exp.host'))).toBe(false);
  });

  test('the agent is given a link with the organization and agent slugs, the phone keeps the ids its check reads, and a failed read gives ids', async () => {
    const at = new Date().toISOString();
    await held.db.insert(organizations).values({ id: OWNER, slug: 'stage-labs', createdAt: at, updatedAt: at });
    await held.db.update(agents).set({ slug: 'emma' }).where(eq(agents.id, 'agent000001'));
    const text = texts(await ask({ page_id: 'five' })).join('\n');
    const id = approvalOf(text);
    expect(text).toContain(`answers it: https://metro.box/#/stage-labs/emma/approvals/${id} Metro posts that link`);
    await until(async () => (await queued()).length > 0);
    expect((await queued())[0]?.url).toBe(`https://metro.box/#/${OWNER}/agent000001/approvals/${id}`);
    app.deps.names = () => Promise.reject(new Error('the database is away'));
    const other = texts(await ask({ page_id: 'six' })).join('\n');
    expect(other).toContain(`answers it: https://metro.box/#/${OWNER}/agent000001/approvals/${approvalOf(other)} Metro posts that link`);
  });

  test('a write that fails never changes the answer to the agent', async () => {
    await held.client.exec('ALTER TABLE "push_outbox" RENAME TO "push_outbox_away"');
    try {
      expect(texts(await ask({ page_id: 'four' })).join('\n')).toContain('needs_approval');
    } finally {
      await held.client.exec('ALTER TABLE "push_outbox_away" RENAME TO "push_outbox"');
    }
  });
});

describe('the notification text', () => {
  const asked = { id: 'abcde', owner: OWNER, agent: 'agent000001', tool: 'Create page', connector: 'Notion' };

  test('an agent with no name is "Your agent", and long names are cut', () => {
    expect(approvalNote(null, asked, APP_URL)).toEqual({ owner: OWNER, agent: 'agent000001', approval: 'abcde', title: 'Your agent needs your approval', body: 'Create page on Notion', url: `https://metro.box/#/${OWNER}/agent000001/approvals/abcde` });
    expect(approvalNote('x'.repeat(500), asked, APP_URL).title).toHaveLength(120);
  });

  test('the link is the approval page of metro.box, or of METRO_APP_URL, the one the agent is given too', () => {
    expect(approvalNote('Emma', asked, 'https://staging.metro.box').url).toBe(`https://staging.metro.box/#/${OWNER}/agent000001/approvals/abcde`);
  });
});
