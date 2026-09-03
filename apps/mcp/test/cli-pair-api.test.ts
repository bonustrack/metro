import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleCliPairRequest } from '../src/daemon/cli-pair-api.js';
import {
  handleAgentConnectorRequest,
  type AgentConnectorApiDeps,
} from '../src/daemon/agent-connector-api.js';
import { mintAgentCode } from '../src/daemon/agent-pair.js';
import {
  signAgentToken,
  signRunToken,
  signSession,
  verifyAgentToken,
} from '../src/daemon/session.js';
import { ApiError } from '../src/daemon/api-error.js';
import type { ConnectorApiDeps } from '../src/daemon/connector-api.js';
import type { AgentConnectors } from '../src/db/agent-connectors.js';

const SECRET = 'a-test-session-secret';
const EMAIL = 'less@bonustrack.co';
const AGENT: AgentConnectors = {
  id: 'agent000001',
  name: 'suzy',
  connectorIds: ['conn0000001'],
};
const CONNECTOR = { id: 'conn0000001', name: 'linear' };

const agentConnectors = async (
  email: string,
  id: string,
): Promise<AgentConnectors> => {
  if (email !== EMAIL || id !== AGENT.id) throw new ApiError('no such agent', 404);
  return Promise.resolve(AGENT);
};

const deps = {
  agentConnectors,
  fenceRuntime: (runtimeId: string) =>
    runtimeId === 'rt1'
      ? Promise.resolve()
      : Promise.reject(new ApiError('this runtime no longer holds the agent', 409)),
  connectorNamesByIds: async (ids: string[]) =>
    Promise.resolve(ids.includes(CONNECTOR.id) ? [CONNECTOR] : []),
} as unknown as ConnectorApiDeps;

const agentDeps: AgentConnectorApiDeps = {
  agentConnectors,
  addConnector: () => Promise.reject(new Error('not under test')),
  removeConnector: () => Promise.reject(new Error('not under test')),
  mintCode: async (email, agentId) => {
    const agent = await agentConnectors(email, agentId);
    return { ...mintAgentCode({ email, agentId }), agent: agent.name };
  },
};

let server: Server;
let base = '';
const prev = process.env.METRO_SESSION_SECRET;
const prevPublic = process.env.METRO_PUBLIC_URL;

beforeAll(async () => {
  process.env.METRO_SESSION_SECRET = SECRET;
  process.env.METRO_PUBLIC_URL = 'https://relay.metro.test';
  server = createServer((req, res) => {
    if (handleCliPairRequest(req, res, deps)) return;
    if (handleAgentConnectorRequest(req, res, agentDeps)) return;
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
  if (prevPublic === undefined) delete process.env.METRO_PUBLIC_URL;
  else process.env.METRO_PUBLIC_URL = prevPublic;
});

const session = (): string => signSession({ email: EMAIL, agentIds: [] }, SECRET);
const agentToken = (agentId = AGENT.id): string =>
  signAgentToken({ email: EMAIL, agentId }, SECRET);
const runToken = (): string =>
  signRunToken({ email: EMAIL, agentId: AGENT.id, runtimeId: 'rt1' }, SECRET);

const get = (path: string, token?: string): Promise<Response> =>
  fetch(`${base}${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

const mint = (token?: string): Promise<Response> =>
  fetch(`${base}/api/agents/${AGENT.id}/code`, {
    method: 'POST',
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

const claim = (code: unknown): Promise<Response> =>
  fetch(`${base}/api/cli/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });

async function freshCode(): Promise<string> {
  const body = (await (await mint(session())).json()) as { code: string };
  return body.code;
}

describe('a code authorises one agent, not an account', () => {
  test('minting needs the signed-in owner', async () => {
    expect((await mint()).status).toBe(401);
    expect((await mint('not-a-session')).status).toBe(401);
    expect((await mint(agentToken())).status).toBe(401);
  });

  test('the mint names the agent it is for', async () => {
    const res = await mint(session());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string; agent: string };
    expect(body.code).toMatch(/^ma_[A-Za-z0-9_-]{16}$/);
    expect(body.agent).toBe('suzy');
  });

  test('claiming takes no session and returns a token bound to that agent', async () => {
    const res = await claim(await freshCode());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; agent: string };
    expect(body.agent).toBe('suzy');
    expect(verifyAgentToken(body.token, SECRET)).toEqual({
      email: EMAIL,
      agentId: AGENT.id,
    });
  });

  test('a code works once and never again', async () => {
    const code = await freshCode();
    expect((await claim(code)).status).toBe(200);
    expect((await claim(code)).status).toBe(400);
  });

  test('a code nobody minted, or a malformed one, is refused', async () => {
    for (const bad of ['ma_aaaaaaaaaaaaaaaa', '', 'nope', 42, null])
      expect((await claim(bad)).status).toBe(400);
  });

  test('malformed and expired are told apart, and pasted whitespace is forgiven', async () => {
    const unminted = (await (await claim('ma_aaaaaaaaaaaaaaaa')).json()) as {
      error: string;
    };
    expect(unminted.error).toContain('expired');
    const wrongShape = (await (await claim('mc_aaaaaaaaaaaaaaaa')).json()) as {
      error: string;
    };
    expect(wrongShape.error).toContain('does not look like an agent code');
    const padded = await claim(`  ${await freshCode()}\r\n`);
    expect(padded.status).toBe(200);
  });
});

describe('an agent token reads its agent and nothing else', () => {
  test('it hands back relay urls carrying the caller token, never the vendor credential', async () => {
    const token = agentToken();
    const res = await get('/api/cli/mcp', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: string; agent: string };
    expect(body.agent).toBe('suzy');
    expect(JSON.parse(body.json)).toEqual({
      mcpServers: {
        'metro.box linear': {
          type: 'http',
          url: `https://relay.metro.test/relay/${CONNECTOR.id}`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    });
    expect(body.json).not.toContain('mcp.linear.app');
  });

  test('it identifies itself by account and agent', async () => {
    const body = (await (await get('/api/cli/session', agentToken())).json()) as {
      email: string;
      agent: string;
    };
    expect(body).toEqual({ email: EMAIL, agent: 'suzy' });
  });

  test('a run token is the same capability here: metro start needs no second sign-in', async () => {
    const res = await get('/api/cli/mcp', runToken());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agent: string }).agent).toBe('suzy');
    expect((await get('/api/cli/session', runToken())).status).toBe(200);
  });

  test('a run token whose lease was taken back is refused', async () => {
    const stale = signRunToken(
      { email: EMAIL, agentId: AGENT.id, runtimeId: 'rt0' },
      SECRET,
    );
    expect((await get('/api/cli/session', stale)).status).toBe(401);
    expect((await get('/api/cli/mcp', stale)).status).toBe(401);
  });

  test('an agent the token does not name is a 404, not a leak', async () => {
    expect((await get('/api/cli/session', agentToken('agent000002'))).status).toBe(404);
  });

  test('a SESSION token is not an agent token, the types do not cross', async () => {
    expect((await get('/api/cli/mcp', session())).status).toBe(401);
    expect((await get('/api/cli/session', session())).status).toBe(401);
  });

  test('an agent token cannot reach the agent admin routes', async () => {
    expect(
      (await get(`/api/agents/${AGENT.id}/connectors`, agentToken())).status,
    ).toBe(401);
  });

  test('an agent token signed by another secret is refused', async () => {
    const other = signAgentToken({ email: EMAIL, agentId: AGENT.id }, 'other');
    expect((await get('/api/cli/mcp', other)).status).toBe(401);
  });

  test('no token at all is 401, and the wrong method is 405', async () => {
    expect((await get('/api/cli/mcp')).status).toBe(401);
    expect(
      (await fetch(`${base}/api/cli/mcp`, { method: 'POST' })).status,
    ).toBe(405);
    expect((await get('/api/cli/nope')).status).toBe(404);
  });
});
