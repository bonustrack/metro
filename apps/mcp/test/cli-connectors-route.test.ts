import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleCliPairRequest } from '../src/daemon/cli-pair-api.js';
import { signAgentToken, signRunToken, signSession } from '../src/daemon/session.js';
import { ApiError } from '../src/daemon/api-error.js';
import type { ConnectorApiDeps } from '../src/daemon/connector-api.js';

const SECRET = 'a-test-session-secret';
const SUBJECT = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const AGENT = { id: 'agent000001', name: 'Tony', connectorIds: ['conn0000001', 'conn0000002'] };
const SUMMARIES = [
  { id: 'conn0000001', name: 'linear', url: 'https://mcp.linear.app/mcp', transport: 'http', signIn: 'connected' as const },
  { id: 'conn0000002', name: 'github', url: 'https://api.githubcopilot.com/mcp', transport: 'http', signIn: null },
];

const deps = {
  agentConnectors: (subject: string, id: string) =>
    subject === SUBJECT && id === AGENT.id
      ? Promise.resolve(AGENT)
      : Promise.reject(new ApiError('no such agent', 404)),
  fenceRuntime: (runtimeId: string) =>
    runtimeId === 'rt1' ? Promise.resolve() : Promise.reject(new ApiError('this runtime no longer holds the agent', 409)),
  connectorNamesByIds: () => Promise.resolve([]),
  connectorSummariesByIds: (ids: string[]) => Promise.resolve(SUMMARIES.filter((s) => ids.includes(s.id))),
} as unknown as ConnectorApiDeps;

let server: Server;
let base = '';
const prev = process.env.METRO_SESSION_SECRET;

beforeAll(async () => {
  process.env.METRO_SESSION_SECRET = SECRET;
  server = createServer((req, res) => {
    if (handleCliPairRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
  if (prev === undefined) delete process.env.METRO_SESSION_SECRET;
  else process.env.METRO_SESSION_SECRET = prev;
});

const read = (token: string): Promise<Response> =>
  fetch(`${base}/api/cli/connectors`, { headers: { authorization: `Bearer ${token}` } });

describe('GET /api/cli/connectors', () => {
  test('an agent token reads its agent connectors, names and hosts and sign-in state, no credential', async () => {
    const res = await read(signAgentToken({ subject: SUBJECT, agentId: AGENT.id }, SECRET));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent: string; connectors: unknown[] };
    expect(body.agent).toBe('Tony');
    expect(body.connectors).toEqual(SUMMARIES);
    expect(JSON.stringify(body)).not.toContain('accessToken');
  });

  test('a live run token reads them too; a fenced one is refused', async () => {
    const live = signRunToken({ subject: SUBJECT, agentId: AGENT.id, runtimeId: 'rt1' }, SECRET);
    expect((await read(live)).status).toBe(200);
    const stale = signRunToken({ subject: SUBJECT, agentId: AGENT.id, runtimeId: 'rt0' }, SECRET);
    expect((await read(stale)).status).toBe(401);
  });

  test('a session token is refused, like everywhere on the cli surface', async () => {
    expect((await read(signSession({ subject: SUBJECT, agentIds: [AGENT.id] }, SECRET))).status).toBe(401);
  });
});
