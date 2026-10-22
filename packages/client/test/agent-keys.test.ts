import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { clearAccount } from '../src/auth/account.js';
import { baseFromSegment, daemonBase, setCurrentServer } from '../src/auth/daemon.js';
import { configurePlatform, memoryKeyValue } from '../src/platform.js';
import { claudeCommand, createAgentKey, decideRemoteApproval, fetchAgentKeys, fetchRemoteApprovals, MCP_URL } from '../src/api/agent-keys.js';
import { approvalCard } from '../src/api/approval-card.js';
import { agentSeed, boxesOf, serverLabel, toServer } from '../src/api/servers.js';
import { installTestAccount } from './account-fixture.js';

const AGENT = 'aB3-_xYz9Qw';
const BASE = `https://api.metro.box/api/agents/${AGENT}`;
const SECRET = `mcp_${'A'.repeat(43)}`;
const realFetch = globalThis.fetch;
const NOW = Date.parse('2026-10-23T09:00:00.000Z');

let sent: { url: string; method: string; body: string | null }[] = [];

function serve(body: unknown, status = 200): void {
  sent = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null });
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
}

beforeAll(() => {
  configurePlatform({ kv: memoryKeyValue() });
  installTestAccount();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setCurrentServer(null);
});

afterAll(() => {
  clearAccount();
});

describe('an agent without a server in the agent list', () => {
  test('is read with no address, and an older api without kind still means a box', () => {
    const remote = toServer({ id: AGENT, kind: 'remote', host: null, name: 'Laptop', slug: 'laptop' });
    expect(remote).toMatchObject({ kind: 'remote', host: null, name: 'Laptop' });
    expect(agentSeed(remote)).toBe(AGENT);
    expect(serverLabel(remote)).toBe('Laptop');
    const box = toServer({ id: 'box00000001', host: 'suzy.ts.net', name: null });
    expect(box).toMatchObject({ kind: 'box', host: 'suzy.ts.net' });
    expect(agentSeed(box)).toBe('suzy.ts.net');
    expect(boxesOf([remote, box]).map((one) => one.id)).toEqual(['box00000001']);
    expect(() => toServer({ id: 'box00000002', host: null })).toThrow('unexpected response');
  });

  test('never points the box calls at another box: they go to api.metro.box, which has no box routes', () => {
    setCurrentServer({ id: 'box00000001', host: 'suzy.ts.net' });
    expect(daemonBase()).toBe(baseFromSegment('suzy.ts.net'));
    setCurrentServer({ id: AGENT, host: null });
    expect(daemonBase()).toBe('https://api.metro.box');
  });
});

describe('access keys', () => {
  test('the list keeps what it can read and never a secret', async () => {
    serve({ tokens: [{ id: 'key00000001', label: 'Claude Code', createdAt: NOW, lastUsedAt: null, revokedAt: null }, { id: 'x' }] });
    expect(await fetchAgentKeys(AGENT)).toEqual([{ id: 'key00000001', label: 'Claude Code', createdAt: NOW, lastUsedAt: null, revokedAt: null }]);
    expect(sent[0]?.url).toBe(`${BASE}/tokens`);
  });

  test('creating one answers the secret once, and a malformed one is refused', async () => {
    serve({ token: { id: 'key00000001', label: 'Laptop', createdAt: NOW, lastUsedAt: null, revokedAt: null }, key: SECRET }, 201);
    expect(await createAgentKey(AGENT, '  Laptop ')).toEqual({ key: { id: 'key00000001', label: 'Laptop', createdAt: NOW, lastUsedAt: null, revokedAt: null }, secret: SECRET });
    expect(sent[0]).toEqual({ url: `${BASE}/tokens`, method: 'POST', body: '{"label":"Laptop"}' });
    serve({ token: { id: 'key00000001', label: 'Laptop', createdAt: NOW }, key: 'not-a-key' }, 201);
    expect(createAgentKey(AGENT, 'Laptop')).rejects.toThrow('unexpected response');
  });

  test('the Claude Code command names the one endpoint and the key as a bearer header', () => {
    expect(claudeCommand(SECRET)).toBe(`claude mcp add --transport http metro ${MCP_URL} --header "Authorization: Bearer ${SECRET}"`);
    expect(MCP_URL).toBe('https://mcp.metro.box/mcp');
  });
});

describe('approvals answered on metro.box', () => {
  test('a pending request becomes the connector card the box page shows', async () => {
    serve({ approvals: [{ id: 'abcde', connector: 'conn0000001', connectorKey: 'notion', connectorName: 'Notion', connectorUrl: 'https://mcp.notion.com', tool: 'create_page', preview: '{"title":"Plan"}', requestedAt: NOW }] });
    const [found] = await fetchRemoteApprovals(AGENT);
    expect(found?.connectorName).toBe('Notion');
    expect(found?.approval).toMatchObject({ id: 'abcde', name: 'notion.create_page', line: '', requestedAt: new Date(NOW).toISOString(), inChat: false });
    const card = approvalCard(found?.approval ?? { id: '', name: '', tool: '', preview: '', input: null, line: '', requestedAt: '', inChat: false, fileBytes: [] });
    expect(card).toMatchObject({ connector: 'notion', title: 'Create page', fields: [{ label: 'Title', value: 'Plan' }] });
  });

  test('an answer posts the decision for that request', async () => {
    serve({ ok: true });
    await decideRemoteApproval(AGENT, 'abcde', 'deny');
    expect(sent[0]).toEqual({ url: `${BASE}/approvals/abcde`, method: 'POST', body: '{"decision":"deny"}' });
  });
});
