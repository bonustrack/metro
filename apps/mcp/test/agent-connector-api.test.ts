import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  handleAgentConnectorRequest,
  type AgentConnectorApiDeps,
} from '../src/daemon/agent-connector-api.js';
import { signSession } from '../src/daemon/session.js';
import { ApiError } from '../src/daemon/api-error.js';
import type { AgentConnectors } from '../src/daemon/agent-connector-api.js';

const SECRET = 'a-test-session-secret';
const ADA = 'ada@lovelace.dev';
const BOB = 'bob@example.com';
const AGENT = 'agent000001';
const LINEAR = 'conn0000001';
const GITHUB = 'conn0000002';
const CLASH = 'conn0000003';
const FOREIGN = 'conn0000009';

let held: string[] = [];

function own(email: string, agentId: string): void {
  if (email !== ADA || agentId !== AGENT) throw new ApiError('no such agent', 404);
}

const view = (): AgentConnectors => ({
  id: AGENT,
  name: 'suzy',
  connectorIds: [...held],
});

const deps: AgentConnectorApiDeps = {
  agentConnectors: (email, agentId) => {
    own(email, agentId);
    return Promise.resolve(view());
  },
  addConnector: (email, agentId, connectorId) => {
    own(email, agentId);
    if (connectorId === FOREIGN) throw new ApiError('no such connector', 404);
    if (connectorId === CLASH)
      throw new ApiError(
        "the agent 'suzy' already has a connector named 'linear'",
        409,
      );
    if (!held.includes(connectorId)) held.push(connectorId);
    return Promise.resolve(view());
  },
  removeConnector: (email, agentId, connectorId) => {
    own(email, agentId);
    held = held.filter((id) => id !== connectorId);
    return Promise.resolve(view());
  },
};

let server: Server;
let base = '';
const prev = process.env.METRO_SESSION_SECRET;

beforeAll(async () => {
  process.env.METRO_SESSION_SECRET = SECRET;
  server = createServer((req, res) => {
    if (handleAgentConnectorRequest(req, res, deps)) return;
    res.writeHead(418).end();
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

beforeEach(() => {
  held = [];
});

afterAll(() => {
  server.close();
  if (prev === undefined) delete process.env.METRO_SESSION_SECRET;
  else process.env.METRO_SESSION_SECRET = prev;
});

const session = (email = ADA): string =>
  signSession({ subject: email, agentIds: [] }, SECRET);

const call = (
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const LIST = `/api/agents/${AGENT}/connectors`;

const ids = async (res: Response): Promise<string[]> =>
  ((await res.json()) as AgentConnectors).connectorIds;

describe('what an agent holds', () => {
  test('reading needs the signed-in owner', async () => {
    expect((await call('GET', LIST)).status).toBe(401);
    expect((await call('GET', LIST, 'junk')).status).toBe(401);
  });

  test('the list is the agent with its connector ids', async () => {
    held = [LINEAR];
    const res = await call('GET', LIST, session());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: AGENT,
      name: 'suzy',
      connectorIds: [LINEAR],
    });
  });

  test('somebody else agent is a flat 404', async () => {
    expect((await call('GET', LIST, session(BOB))).status).toBe(404);
    expect(
      (await call('POST', LIST, session(BOB), { connectorId: LINEAR })).status,
    ).toBe(404);
  });
});

describe('adding and removing', () => {
  test('adding is one connector at a time, idempotent, and answers the new list', async () => {
    expect(await ids(await call('POST', LIST, session(), { connectorId: LINEAR }))).toEqual([
      LINEAR,
    ]);
    expect(await ids(await call('POST', LIST, session(), { connectorId: LINEAR }))).toEqual([
      LINEAR,
    ]);
    expect(await ids(await call('POST', LIST, session(), { connectorId: GITHUB }))).toEqual([
      LINEAR,
      GITHUB,
    ]);
  });

  test('a connector outside the project is 404, a name clash 409', async () => {
    expect((await call('POST', LIST, session(), { connectorId: FOREIGN })).status).toBe(404);
    const res = await call('POST', LIST, session(), { connectorId: CLASH });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(
      'already has a connector named',
    );
  });

  test('a missing or malformed connectorId is 400 before anything is looked up', async () => {
    expect((await call('POST', LIST, session(), {})).status).toBe(400);
    expect((await call('POST', LIST, session(), { connectorId: 'short' })).status).toBe(400);
    expect((await call('POST', LIST, session(), { connectorId: 7 })).status).toBe(400);
  });

  test('removing answers what remains', async () => {
    held = [LINEAR, GITHUB];
    const res = await call('DELETE', `${LIST}/${LINEAR}`, session());
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual([GITHUB]);
  });
});

describe('the shape of the routes', () => {
  test('a wrong method is 405, OPTIONS is 204, and a bad connector id is 404', async () => {
    expect((await call('PUT', LIST, session())).status).toBe(405);
    expect((await call('OPTIONS', LIST)).status).toBe(204);
    expect((await call('DELETE', `${LIST}/short`, session())).status).toBe(404);
    expect((await call('DELETE', `${LIST}/${LINEAR}/extra`, session())).status).toBe(404);
    expect((await call('GET', `${LIST}/${LINEAR}`, session())).status).toBe(405);
  });

  test('every other agent route is left to the agent api', async () => {
    expect((await call('GET', '/api/agents', session())).status).toBe(418);
    expect((await call('POST', `/api/agents/${AGENT}/key`, session())).status).toBe(418);
    expect((await call('GET', `/api/agents/${AGENT}`, session())).status).toBe(418);
    expect((await call('GET', `/api/agents/short/connectors`, session())).status).toBe(418);
  });
});
