import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { log } from '@metro-labs/core/log';
import { MCP_PATHS, mcpApprovalsOf } from '@metro-labs/http/mcp-server-protocol';
import { connectors } from '@metro-labs/connectors/db/schema';
import { openConnectorSecret, type ConnectorSecret } from '@metro-labs/connectors/model';
import { addConnector, assign, callTool, enrollAgent, headerSecret, MASTER, PGLITE_START_MS, rewrite, signed, startApp, testDb, texts, VENDOR_ORIGIN, type TestAgent, type TestApp, type TestDb } from './helpers.ts';
import { startVendor, type FakeVendor } from './vendor.ts';

let held: TestDb;
let vendor: FakeVendor;
let app: TestApp;
let agent: TestAgent;

beforeAll(async () => {
  held = await testDb();
  vendor = await startVendor();
}, PGLITE_START_MS);
beforeEach(async () => {
  await held.reset();
  vendor.calls.length = 0;
  vendor.methods.length = 0;
  vendor.tokenForms.length = 0;
  vendor.state.accepted = 'Bearer VENDOR_KEY';
  vendor.state.sse = false;
  vendor.state.refreshTo = null;
  vendor.state.answerOrder = [];
  agent = await enrollAgent(held.db, 'agent000001');
  await addConnector(held.db, 'conn0000001', 'Notion', headerSecret('/mcp?key=URL_SECRET'));
  await assign(held.db, 'conn0000001', agent.row.agent);
  app = await startApp(held.db, rewrite(vendor.base));
});
afterEach(async () => { await app.close(); });
afterAll(async () => {
  await vendor.close();
  await held.close();
});

const find = (query: string, max?: number) => callTool(app, agent.token, 'tool_search', { query, ...(max === undefined ? {} : { max_results: max }) });
const run = (calls: unknown[]) => callTool(app, agent.token, 'tool_call', { calls });

async function answerAs(who: TestAgent, id: string, decision: 'allow' | 'deny'): Promise<number> {
  const request = signed(who, MCP_PATHS.answer, { id, decision });
  return (await fetch(`${app.base}${MCP_PATHS.answer}`, { method: 'POST', body: request.body, headers: request.headers })).status;
}

function oauthSecret(expiresAt: number, refreshToken: string | undefined = 'REFRESH_OLD'): ConnectorSecret {
  return {
    kind: 'oauth', targetUrl: `${VENDOR_ORIGIN}/mcp`,
    server: { issuer: VENDOR_ORIGIN, authorizationEndpoint: `${VENDOR_ORIGIN}/authorize`, tokenEndpoint: `${VENDOR_ORIGIN}/token`, registrationEndpoint: null, supportsS256: true, scopes: [] },
    client: { clientId: 'CLIENT_ID' },
    tokens: { accessToken: 'ACCESS_OLD', expiresAt, resource: `${VENDOR_ORIGIN}/mcp`, ...(refreshToken === undefined ? {} : { refreshToken }) },
  };
}

describe('tool_search against a real connector', () => {
  test('keywords return the <functions> encoding with the vendor schema, and no credential', async () => {
    const result = await find('notion page update');
    const [text] = texts(result);
    expect(text?.startsWith('<functions>\n<function>{"name":"notion.update_page","title":"Update page"')).toBe(true);
    expect(text).toContain('"parameters":{"type":"object","properties":{"page_id":{"type":"string"}');
    expect(text).not.toContain('URL_SECRET');
    expect(text).not.toContain('VENDOR_KEY');
    expect(vendor.methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'DELETE']);
    expect(text?.split('\n').at(-1)).toBe('Call these with tool_call: {"calls":[{"tool":"notion.update_page","arguments":{…}}]}');
  });

  test('select: loads exact tools, and the tool list is cached', async () => {
    const text = texts(await find('select:notion.search,notion.delete_page'))[0] ?? '';
    expect(text.split('\n').filter((line) => line.startsWith('<function>'))).toHaveLength(2);
    await find('select:notion.search');
    expect(vendor.methods.filter((method) => method === 'tools/list')).toHaveLength(1);
  });

  test('no match names the agent\'s connectors', async () => {
    expect(texts(await find('spreadsheet'))[0]).toBe('No tool matched "spreadsheet". This agent\'s connectors: notion. Try a broader query with fewer words, or "select:<connector>.<tool>" with an exact name.');
  });

  test('the answer carries every connector\'s key and name, and the connector of each tool', async () => {
    await addConnector(held.db, 'conn0000009', 'X50 rosa@bonustrack.co', headerSecret());
    await assign(held.db, 'conn0000009', agent.row.agent);
    const result = await find('select:notion.search');
    expect(result.structuredContent).toEqual({
      connectors: [{ key: 'notion', name: 'Notion', status: 'ok' }, { key: 'x50-rosa-bonustrack-co', name: 'X50 rosa@bonustrack.co' }],
      tools: [{ name: 'notion.search', title: 'Search pages', connector: 'notion' }],
    });
    const miss = await find('spreadsheet');
    expect(texts(miss)[0]).toContain("This agent's connectors: notion, x50-rosa-bonustrack-co (X50 rosa@bonustrack.co).");
    expect(miss.structuredContent?.tools).toEqual([]);
  });

  test('blocked tools are never returned', async () => {
    await held.db.update(connectors).set({ policy: JSON.stringify({ tools: { delete_page: 'deny' } }) }).where(eq(connectors.id, 'conn0000001'));
    expect(texts(await find('select:notion.delete_page,notion.search'))[0]).not.toContain('delete_page');
    await held.db.update(connectors).set({ policy: JSON.stringify({ read: 'deny', write: 'deny' }) }).where(eq(connectors.id, 'conn0000001'));
    expect(texts(await find('notion'))[0]).toBe('No tool matched "notion". This agent has no connectors it may use.');
  });

  test('a connector the vendor refuses says it needs a new sign-in', async () => {
    vendor.state.accepted = 'Bearer SOMETHING_ELSE';
    expect(texts(await find('notion'))[0]).toContain('notion: Notion needs to be signed in again on metro.box');
  });
});

describe('tool_call against a real connector', () => {
  test('runs calls in parallel and answers each under its [n] header', async () => {
    const info = spyOn(log, 'info');
    vendor.state.answerOrder = ['update_page', 'search'];
    const result = await run([{ tool: 'notion.search', arguments: { query: 'roadmap' } }, { tool: 'notion.update_page', arguments: { page_id: 'p1' } }]);
    expect(result.isError).toBeUndefined();
    expect(texts(result)).toEqual(['[1] notion.search', 'search ran with {"query":"roadmap"}', '[2] notion.update_page', 'update_page ran with {"page_id":"p1"}']);
    expect(vendor.calls.map((call) => call.authorization)).toEqual(['Bearer VENDOR_KEY', 'Bearer VENDOR_KEY']);
    const lines = info.mock.calls.filter((call) => call[1] === 'mcp: call').map((call) => call[0]);
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(expect.arrayContaining(['search', 'update_page'].map((tool) => expect.objectContaining({ agent: 'agent000001', connector: 'conn0000001', tool, outcome: 'ok' }))));
    expect(JSON.stringify(lines)).not.toContain('roadmap');
    info.mockRestore();
  });

  test('a vendor answering over SSE after a progress notice still gives its result', async () => {
    vendor.state.sse = true;
    expect(texts(await run([{ tool: 'notion.search', arguments: { query: 'x' } }]))).toEqual(['[1] notion.search', 'search ran with {"query":"x"}']);
  });

  test('the result is an error only when every call failed', async () => {
    await find('notion');
    const mixed = await run([{ tool: 'notion.search', arguments: {} }, { tool: 'notion.nope', arguments: {} }, { tool: 'jira.search', arguments: {} }]);
    expect(mixed.isError).toBeUndefined();
    const lines = texts(mixed);
    expect(lines[3]).toBe('not_found: notion has no tool named nope. Closest: notion.search, notion.delete_page, notion.update_page. Run tool_search first.');
    expect(lines[5]).toBe('not_found: No connector named "jira" is assigned to this agent. This agent\'s connectors: notion. Closest: notion.search. Run tool_search first.');
    vendor.state.answer = () => ({ content: [{ type: 'text', text: 'boom' }], isError: true });
    const failed = await run([{ tool: 'notion.search', arguments: {} }]);
    expect(failed.isError).toBe(true);
    expect(texts(failed)).toEqual(['[1] notion.search', 'boom']);
    vendor.state.answer = (tool, args) => ({ content: [{ type: 'text', text: `${tool} ran with ${JSON.stringify(args)}` }] });
  });

  test('Block answers with the owner\'s policy and never reaches the vendor', async () => {
    await held.db.update(connectors).set({ policy: JSON.stringify({ write: 'deny' }) }).where(eq(connectors.id, 'conn0000001'));
    const result = await run([{ tool: 'notion.update_page', arguments: { page_id: 'p1' } }]);
    expect(result.isError).toBe(true);
    expect(texts(result)).toEqual(['[1] notion.update_page', 'blocked: Blocked by the owner\'s policy for notion (update_page).']);
    expect(vendor.calls).toEqual([]);
  });

  test('Ask: needs_approval, the daemon sees it, the owner allows, the same call runs once with the approval', async () => {
    await held.db.update(connectors).set({ policy: JSON.stringify({ write: 'ask' }) }).where(eq(connectors.id, 'conn0000001'));
    const call = { tool: 'notion.update_page', arguments: { page_id: 'p1', title: 'Q4' } };
    const first = texts(await run([call]));
    const id = /approval ([a-km-z]{5})/.exec(first[1] ?? '')?.[1] ?? '';
    expect(first[1]).toStartWith(`needs_approval: The owner must approve notion.update_page with these arguments first (approval ${id}).`);
    expect(texts(await run([call]))[1]).toContain(`(approval ${id})`);
    const request = signed(agent, MCP_PATHS.approvals, {});
    const delivered = mcpApprovalsOf(await (await fetch(`${app.base}${MCP_PATHS.approvals}`, { method: 'POST', body: request.body, headers: request.headers })).json());
    expect(delivered).toEqual([{ id, connector: 'notion', tool: 'update_page', preview: '{"page_id":"p1","title":"Q4"}', requestedAt: expect.any(Number) as unknown as number, origin: 'box' }]);
    expect(texts(await run([{ ...call, approval: id }]))[1]).toContain('needs_approval');
    expect(await answerAs(agent, id, 'allow')).toBe(200);
    expect(texts(await run([{ ...call, arguments: { page_id: 'p2', title: 'Q4' }, approval: id }]))[1]).toContain('needs_approval');
    expect(vendor.calls).toEqual([]);
    expect(texts(await run([{ ...call, approval: id }]))).toEqual(['[1] notion.update_page', 'update_page ran with {"page_id":"p1","title":"Q4"}']);
    expect(texts(await run([{ ...call, approval: id }]))[1]).toContain('needs_approval');
    expect(vendor.calls).toHaveLength(1);
    expect(texts(await run([{ tool: 'notion.search', arguments: { query: 'reads stay allowed' } }]))[1]).toContain('search ran');
  });

  test('Ask then deny answers denied', async () => {
    await held.db.update(connectors).set({ policy: JSON.stringify({ tools: { delete_page: 'ask' } }) }).where(eq(connectors.id, 'conn0000001'));
    const call = { tool: 'notion.delete_page', arguments: { page_id: 'p1' } };
    const id = /approval ([a-km-z]{5})/.exec(texts(await run([call]))[1] ?? '')?.[1] ?? '';
    expect(await answerAs(agent, id, 'deny')).toBe(200);
    expect(texts(await run([{ ...call, approval: id }]))[1]).toBe(`denied: The owner denied this call (approval ${id}). Do not repeat it.`);
    expect(vendor.calls).toEqual([]);
  });

  test('the agent assignment layer can only make it stricter', async () => {
    await held.db.update(connectors).set({ policy: JSON.stringify({ write: 'ask' }) }).where(eq(connectors.id, 'conn0000001'));
    await held.db.execute(`UPDATE connector_agents SET policy = '{"write":"deny"}' WHERE agent = 'agent000001'`);
    expect(texts(await run([{ tool: 'notion.update_page', arguments: {} }]))[1]).toStartWith('blocked:');
  });
});

describe('OAuth connectors', () => {
  test('an expired access token is refreshed centrally before the call', async () => {
    await addConnector(held.db, 'conn0000002', 'Linear', oauthSecret(Date.now() - 1), { auth: 'oauth' });
    await assign(held.db, 'conn0000002', agent.row.agent);
    vendor.state.refreshTo = 'ACCESS_NEW';
    vendor.state.accepted = 'Bearer ACCESS_NEW';
    expect(texts(await run([{ tool: 'linear.search', arguments: { query: 'x' } }]))[1]).toBe('search ran with {"query":"x"}');
    expect(vendor.tokenForms.map((form) => form.get('refresh_token'))).toEqual(['REFRESH_OLD']);
    const row = (await held.db.select().from(connectors).where(eq(connectors.id, 'conn0000002')))[0];
    const secret = row === undefined ? null : openConnectorSecret(MASTER, row);
    expect(secret?.kind === 'oauth' ? secret.tokens?.accessToken : null).toBe('ACCESS_NEW');
  });

  test('a 401 forces one refresh and one retry', async () => {
    await addConnector(held.db, 'conn0000002', 'Linear', oauthSecret(Date.now() + 3600_000), { auth: 'oauth' });
    await assign(held.db, 'conn0000002', agent.row.agent);
    vendor.state.refreshTo = 'ACCESS_NEW';
    vendor.state.accepted = 'Bearer ACCESS_NEW';
    expect(texts(await run([{ tool: 'linear.search', arguments: {} }]))[1]).toBe('search ran with {}');
    expect(vendor.tokenForms).toHaveLength(1);
  });

  test('a credential the vendor still refuses after the refresh asks for a new sign-in', async () => {
    await addConnector(held.db, 'conn0000002', 'Linear', oauthSecret(Date.now() + 3600_000, undefined), { auth: 'oauth' });
    await assign(held.db, 'conn0000002', agent.row.agent);
    vendor.state.accepted = 'Bearer NOTHING_WORKS';
    const result = await run([{ tool: 'linear.search', arguments: {} }]);
    expect(result.isError).toBe(true);
    expect(texts(result)[1]).toBe('signin: Linear needs to be signed in again on metro.box (Connectors), so Metro cannot use it now.');
  });

  test('an expired grant the provider refuses to refresh asks for a new sign-in', async () => {
    await addConnector(held.db, 'conn0000002', 'Linear', oauthSecret(Date.now() - 1), { auth: 'oauth' });
    await assign(held.db, 'conn0000002', agent.row.agent);
    expect(texts(await run([{ tool: 'linear.search', arguments: {} }]))[1]).toStartWith('signin:');
    expect(vendor.calls).toEqual([]);
  });
});
