import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_TOKEN_RE } from '@metro-labs/http/mcp-server-protocol';
import { newAgentKey, saveAgentKey, type AgentKey } from '../src/connectors/agent-key.ts';
import { mcpServerUrl } from '../src/mcp-server/config.ts';
import { stopMcpServer, watchMcpServer, type McpServerLink } from '../src/mcp-server/link.ts';
import { readMcpToken } from '@metro-labs/core/mcp-server';
import { mcpTokenHash } from '../src/mcp-server/token.ts';
import { viewFiles } from '../src/agent-user/view.ts';
import { AGENT, fakeMcpServer, linkTo, OWNER, type FakeMcpServer } from './mcp-server-fixture.ts';
import { settle, waitFor } from './wait.ts';

let fake: FakeMcpServer;
let dir = '';
let link: McpServerLink | undefined;
let savedUrl: string | undefined;

const enroll = (key: AgentKey = newAgentKey(), organization = OWNER): AgentKey => {
  saveAgentKey(key, { server: AGENT, organization, at: new Date().toISOString() }, dir);
  fake.signers.add(key.signingKey);
  return key;
};

const registered = (): Seen[] => fake.seen.filter((s) => s.path === '/v1/token');

type Seen = FakeMcpServer['seen'][number];

const start = (owner = OWNER): McpServerLink => {
  link = linkTo(fake, dir, () => undefined, undefined, owner);
  link.start();
  return link;
};

beforeAll(async () => {
  fake = await fakeMcpServer();
  savedUrl = process.env.METRO_MCP_SERVER_URL;
});

afterAll(async () => {
  await fake.close();
  if (savedUrl === undefined) delete process.env.METRO_MCP_SERVER_URL;
  else process.env.METRO_MCP_SERVER_URL = savedUrl;
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-mcp-token-'));
  fake.seen = [];
  fake.signers.clear();
  fake.pending = [];
  fake.answers = [];
  fake.reply = null;
});

afterEach(async () => {
  await link?.stop();
  link = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('the MCP token', () => {
  test('is made once the agent is enrolled, kept 0600 in Metro\'s folder, and only its SHA-256 is sent, signed by the agent', async () => {
    const key = enroll();
    start();
    await waitFor(() => registered().length > 0);
    const token = readMcpToken(dir);
    expect(token).toMatch(MCP_TOKEN_RE);
    expect(statSync(join(dir, 'mcp-token')).mode & 0o777).toBe(0o600);
    expect(registered()).toHaveLength(1);
    expect(registered()[0]?.body).toEqual({ tokenHash: mcpTokenHash(token ?? '') });
    expect(registered()[0]?.keyId).toBe(key.keyId);
    expect(JSON.stringify(fake.seen)).not.toContain(token ?? 'none');
    await waitFor(() => fake.seen.some((s) => s.path === '/v1/approvals'));
    expect(fake.seen.find((s) => s.path === '/v1/approvals')?.body).toEqual({});
  });

  test('survives a restart unchanged and is registered again, so a server that forgot it learns it back', async () => {
    enroll();
    start();
    await waitFor(() => registered().length > 0);
    const first = readMcpToken(dir);
    await link?.stop();
    start();
    await waitFor(() => registered().length > 1);
    expect(readMcpToken(dir)).toBe(first);
    expect(registered().map((s) => s.body.tokenHash)).toEqual([mcpTokenHash(first ?? ''), mcpTokenHash(first ?? '')]);
  });

  test('is replaced and registered with the new key after a new enrollment', async () => {
    enroll();
    start();
    await waitFor(() => registered().length > 0);
    const first = readMcpToken(dir);
    const next = enroll();
    await waitFor(() => registered().length > 1);
    const second = readMcpToken(dir);
    expect(second).not.toBe(first);
    expect(registered()[1]?.keyId).toBe(next.keyId);
    expect(registered()[1]?.body).toEqual({ tokenHash: mcpTokenHash(second ?? '') });
  });

  test('is registered again, unchanged, when the server answers 401 to the approval poll', async () => {
    enroll();
    fake.reply = (path, count) => (path === '/v1/approvals' && count === 1 ? { status: 401, body: { error: 'unknown token' } } : null);
    start();
    await waitFor(() => registered().length > 1);
    expect(new Set(registered().map((s) => s.body.tokenHash)).size).toBe(1);
    expect(fake.seen.map((s) => s.path).slice(0, 3)).toEqual(['/v1/token', '/v1/approvals', '/v1/token']);
  });

  test('registration is retried with a growing pause until the server takes it', async () => {
    enroll();
    fake.reply = (path, count) => (path === '/v1/token' && count <= 3 ? { status: 503, body: { error: 'down' } } : null);
    start();
    await waitFor(() => fake.seen.some((s) => s.path === '/v1/approvals'));
    const times = registered().map((s) => s.at);
    expect(times).toHaveLength(4);
    const gaps = times.slice(1).map((at, i) => at - (times[i] ?? at));
    expect(gaps[0]).toBeGreaterThanOrEqual(15);
    expect(gaps[1]).toBeGreaterThanOrEqual(35);
    expect(gaps[2]).toBeGreaterThanOrEqual(75);
  });

  test('nothing is made or sent while the agent is not enrolled, or is enrolled with another organization', async () => {
    start();
    await settle(150);
    expect(fake.seen).toEqual([]);
    expect(existsSync(join(dir, 'mcp-token'))).toBe(false);
    await link?.stop();
    enroll(newAgentKey(), 'org_01SOMEONEELSE00000');
    start();
    await settle(150);
    expect(fake.seen).toEqual([]);
    expect(existsSync(join(dir, 'mcp-token'))).toBe(false);
  });
});

describe('METRO_MCP_SERVER_URL', () => {
  test('unset, it is mcp.metro.box', () => {
    delete process.env.METRO_MCP_SERVER_URL;
    expect(mcpServerUrl()).toBe('https://mcp.metro.box');
    expect(mcpServerUrl({})).toBe('https://mcp.metro.box');
    writeFileSync(join(dir, 'mcp-token'), `mcp_${'A'.repeat(43)}\n`);
    expect(viewFiles(dir).get('mcp-token')).toBe(`mcp_${'A'.repeat(43)}\n`);
  });

  test('set empty, nothing runs and the agent view leaves the token out', async () => {
    process.env.METRO_MCP_SERVER_URL = '';
    try {
      expect(mcpServerUrl()).toBeNull();
      expect(watchMcpServer({ owner: () => OWNER, hold: () => undefined })).toBe(false);
      writeFileSync(join(dir, 'mcp-token'), `mcp_${'A'.repeat(43)}\n`);
      expect([...viewFiles(dir).keys()]).not.toContain('mcp-token');
      await stopMcpServer();
    } finally {
      delete process.env.METRO_MCP_SERVER_URL;
    }
  });

  test('set, the token is copied into the agent view as it is', () => {
    process.env.METRO_MCP_SERVER_URL = 'https://mcp.metro.box/';
    try {
      expect(mcpServerUrl()).toBe('https://mcp.metro.box');
      writeFileSync(join(dir, 'mcp-token'), `mcp_${'A'.repeat(43)}\n`);
      expect(viewFiles(dir).get('mcp-token')).toBe(`mcp_${'A'.repeat(43)}\n`);
    } finally {
      delete process.env.METRO_MCP_SERVER_URL;
    }
  });

  test('must be https, or http on this machine only, with no credentials', () => {
    for (const bad of ['http://mcp.metro.box', 'https://user:pw@mcp.metro.box', 'https://mcp.metro.box/?a=1', 'mcp.metro.box', 'ftp://x'])
      expect(mcpServerUrl({ METRO_MCP_SERVER_URL: bad })).toBeNull();
    expect(mcpServerUrl({ METRO_MCP_SERVER_URL: 'http://127.0.0.1:18080' })).toBe('http://127.0.0.1:18080');
    expect(mcpServerUrl({ METRO_MCP_SERVER_URL: ' ' })).toBeNull();
  });
});
