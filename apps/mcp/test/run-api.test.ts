import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleRunApiRequest, type RunApiDeps } from '../src/daemon/run-api.js';
import { mintRunCode } from '../src/daemon/run-pair.js';
import {
  signCliToken,
  signRunToken,
  signSession,
} from '../src/daemon/session.js';
import { ApiError } from '../src/daemon/api-error.js';

const SECRET = 'a-test-session-secret';
const ADA = 'ada@lovelace.dev';
const AGENT = 'agent000001';

let holder: string | null = null;
let touched: string[] = [];
let claims = 0;

const deps: RunApiDeps = {
  claimRuntime: (agentId, label) => {
    claims += 1;
    holder = `rt${String(claims)}`;
    return Promise.resolve({ runtimeId: holder, agentId, label });
  },
  fenceRuntime: (runtimeId) => {
    if (runtimeId !== holder)
      throw new ApiError('this runtime no longer holds the agent', 409);
    return Promise.resolve();
  },
  touchRuntime: (runtimeId) => {
    touched.push(runtimeId);
    return Promise.resolve();
  },
  loadAgent: (agentId) =>
    Promise.resolve({
      id: agentId,
      name: 'local',
      key: 'mk_agent_key',
      accounts: [
        {
          station: 'telegram-bot',
          id: 'stn00000001',
          allowlist: ['*'],
          config: { botToken: 'secret-token' },
        },
      ],
    }),
};

let server: Server;
let base = '';
const prev = process.env.METRO_SESSION_SECRET;

beforeAll(async () => {
  process.env.METRO_SESSION_SECRET = SECRET;
  server = createServer((req, res) => {
    if (handleRunApiRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

beforeEach(() => {
  holder = null;
  touched = [];
  claims = 0;
});

afterAll(() => {
  server.close();
  if (prev === undefined) delete process.env.METRO_SESSION_SECRET;
  else process.env.METRO_SESSION_SECRET = prev;
});

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

async function claim(): Promise<string> {
  const { code } = mintRunCode({ email: ADA, agentId: AGENT });
  const res = await call('POST', '/api/run/claim', undefined, {
    code,
    label: 'lisa',
  });
  return ((await res.json()) as { token: string }).token;
}

describe('claiming an agent for a local runtime', () => {
  test('a fresh code is traded for a run token', async () => {
    const { code } = mintRunCode({ email: ADA, agentId: AGENT });
    const res = await call('POST', '/api/run/claim', undefined, {
      code,
      label: 'lisa',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ agent: AGENT, label: 'lisa' });
  });

  test('a code is single-use', async () => {
    const { code } = mintRunCode({ email: ADA, agentId: AGENT });
    await call('POST', '/api/run/claim', undefined, { code });
    const again = await call('POST', '/api/run/claim', undefined, { code });
    expect(again.status).toBe(400);
  });

  test('a malformed code is refused without touching the store', async () => {
    const res = await call('POST', '/api/run/claim', undefined, {
      code: 'not-a-code',
    });
    expect(res.status).toBe(400);
    expect(claims).toBe(0);
  });
});

describe('reading the station config', () => {
  test('the holder gets its agent, credentials included', async () => {
    const token = await claim();
    const res = await call('GET', '/api/run/config', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent: { accounts: { config: { botToken: string } }[] };
    };
    expect(body.agent.accounts[0]?.config.botToken).toBe('secret-token');
  });

  test('the read doubles as the heartbeat', async () => {
    const token = await claim();
    await call('GET', '/api/run/config', token);
    expect(touched).toEqual([holder ?? '']);
  });

  test('a superseded runtime is fenced off with 409, not served stale config', async () => {
    const first = await claim();
    await claim();
    const res = await call('GET', '/api/run/config', first);
    expect(res.status).toBe(409);
    expect(touched).toEqual([]);
  });

  test('no token is 401', async () => {
    expect((await call('GET', '/api/run/config')).status).toBe(401);
  });
});

describe('the run token is its own capability, in both directions', () => {
  test('a session JWT cannot read station config', async () => {
    const session = signSession({ email: ADA, agentIds: [AGENT] }, SECRET);
    expect((await call('GET', '/api/run/config', session)).status).toBe(401);
  });

  test('a CLI token cannot read station config', async () => {
    const cli = signCliToken({ email: ADA, collectionId: 'col00000001' }, SECRET);
    expect((await call('GET', '/api/run/config', cli)).status).toBe(401);
  });

  test('a run token signed with another secret is refused', async () => {
    const forged = signRunToken(
      { email: ADA, agentId: AGENT, runtimeId: 'rt1' },
      'a-different-secret',
    );
    expect((await call('GET', '/api/run/config', forged)).status).toBe(401);
  });
});

describe('the shape of the route itself', () => {
  test('a wrong method is 405 and an unknown sub-route is 404', async () => {
    expect((await call('GET', '/api/run/claim')).status).toBe(405);
    expect((await call('POST', '/api/run/config')).status).toBe(405);
    expect((await call('GET', '/api/run/nope')).status).toBe(404);
  });
});
