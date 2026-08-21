import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { signSession } from '../src/daemon/session.ts';
import { ApiError } from '../src/daemon/api-error.ts';
import {
  ConnectorVerifyError,
  parseConnectorUrl,
} from '../src/daemon/connector-verify.ts';
import type { ConnectorApiDeps } from '../src/daemon/connector-api.ts';
import { setKeyMap } from '../src/db/key-map.ts';

const SECRET = 'connector-api-test-secret';
const ADA = 'ada@lovelace.dev';
const BOB = 'bob@builder.dev';

const AGENT_KEY = 'mk_connector_surface_probe';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;

interface ConnectorInput {
  name: unknown;
  url: unknown;
  header: unknown;
  value: unknown;
}

interface Row {
  id: number;
  email: string;
  name: string;
  url: string;
  header: string | null;
  secret: string | null;
}

interface WireConnector {
  id: number;
  name: string;
  url: string;
  transport: string;
  auth: string;
  header: string | null;
  secret: string | null;
  json: string;
  verified: {
    at: string;
    server: string;
    version: string;
    protocol: string;
    tools: number;
  };
}

const SEED: Row[] = [
  {
    id: 1,
    email: ADA,
    name: 'linear',
    url: 'https://mcp.linear.app/mcp',
    header: 'Authorization',
    secret: 'Bearer lin_oauth_7f',
  },
  {
    id: 2,
    email: ADA,
    name: 'docs',
    url: 'https://docs.example.com/mcp',
    header: null,
    secret: null,
  },
  {
    id: 3,
    email: BOB,
    name: 'notion',
    url: 'https://mcp.notion.com/mcp',
    header: 'X-Api-Key',
    secret: 'ntn_bob_secret',
  },
];

let server: Server;
let base: string;
let rows: Row[] = [...SEED];
let nextId = 10;
let calls: string[] = [];
let priorSecret: string | undefined;
let priorHost: string | undefined;

const VERIFIED = {
  at: '2026-08-21T09:14:04.880Z',
  server: 'linear',
  version: '1.4.0',
  protocol: '2025-06-18',
  tools: 12,
};

const toConnector = (row: Row) => ({
  id: row.id,
  name: row.name,
  url: row.url,
  transport: 'http',
  auth: row.secret === null ? 'none' : 'header',
  header: row.header,
  secret: row.secret,
  verified: VERIFIED,
});

const missing = (): ApiError => new ApiError('no such connector', 404);

function ownedOrThrow(email: string, id: number): Row {
  const row = rows.find((r) => r.id === id && r.email === email);
  if (row === undefined) throw missing();
  return row;
}

function makeRow(email: string, input: ConnectorInput): Row {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!NAME_RE.test(name))
    throw new ApiError(
      'name must be 2-32 characters of A-Z, a-z, 0-9, - or _, starting with a letter or digit',
      400,
    );
  const url = parseConnectorUrl(input.url);
  const header = typeof input.header === 'string' ? input.header : null;
  const value = typeof input.value === 'string' ? input.value : null;
  if (header !== null && value === null)
    throw new ApiError(
      'that header has no value — give both a header name and its value, or neither',
      400,
    );
  if (url.hostname === 'rejects.example.com')
    throw new ConnectorVerifyError(`${url.hostname} rejected that credential.`, 400);
  if (url.hostname === 'down.example.com')
    throw new ConnectorVerifyError(`Metro could not reach ${url.hostname}.`, 400);
  if (rows.some((r) => r.email === email && r.name === name))
    throw new ApiError(`you already have a connector named '${name}'`, 409);
  nextId += 1;
  return {
    id: nextId,
    email,
    name,
    url: url.toString(),
    header: value === null ? null : (header ?? 'Authorization'),
    secret: value,
  };
}

const deps: ConnectorApiDeps = {
  listConnectors: async (email) => {
    calls.push(`list ${email}`);
    return rows.filter((r) => r.email === email).map(toConnector);
  },
  createConnector: async (email, input) => {
    calls.push(`create ${email}`);
    const row = makeRow(email, input);
    rows.push(row);
    return toConnector(row);
  },
  verifyConnector: async (email, id) => {
    calls.push(`verify ${email} ${id}`);
    const row = ownedOrThrow(email, id);
    if (row.url.includes('rejects.example.com'))
      return {
        id: row.id,
        name: row.name,
        ok: false,
        reason: 'rejects.example.com rejected that credential.',
      };
    return { id: row.id, name: row.name, ok: true, verified: VERIFIED };
  },
  deleteConnector: async (email, id) => {
    calls.push(`delete ${email} ${id}`);
    const row = ownedOrThrow(email, id);
    rows = rows.filter((r) => r.id !== id);
    return { id: row.id, name: row.name };
  },
};

const session = (email: string, secret = SECRET): string =>
  signSession({ email, agentIds: [] }, secret);

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

const listFor = async (email: string): Promise<WireConnector[]> => {
  const res = await call('GET', '/api/connectors', session(email));
  const wire = (await res.json()) as { connectors: WireConnector[] };
  return wire.connectors;
};

beforeAll(async () => {
  priorSecret = process.env.METRO_SESSION_SECRET;
  priorHost = process.env.METRO_HTTP_HOST;
  process.env.METRO_SESSION_SECRET = SECRET;
  process.env.METRO_WEBHOOK_PORT = String(
    20000 + Math.floor(Math.random() * 20000),
  );
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  server = await startWebhookServer(
    makeEmit(),
    undefined,
    () => Promise.resolve({ result: null }),
    undefined,
    deps,
  );
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (priorSecret === undefined) delete process.env.METRO_SESSION_SECRET;
  else process.env.METRO_SESSION_SECRET = priorSecret;
  if (priorHost === undefined) delete process.env.METRO_HTTP_HOST;
  else process.env.METRO_HTTP_HOST = priorHost;
});

afterEach(() => {
  rows = [...SEED];
  nextId = 10;
  calls = [];
});

describe('/api/connectors is the Google session surface', () => {
  test('no token is 401', async () => {
    const res = await call('GET', '/api/connectors');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(calls).toEqual([]);
  });

  test('a session signed with another secret is 401', async () => {
    const res = await call('GET', '/api/connectors', session(ADA, 'other-secret'));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test('an expired session is 401', async () => {
    const stale = signSession({ email: ADA, agentIds: [] }, SECRET, {
      ttlSec: -10,
    });
    expect((await call('GET', '/api/connectors', stale)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  test('a ?token= query param authenticates too', async () => {
    const res = await fetch(
      `${base}/api/connectors?token=${encodeURIComponent(session(ADA))}`,
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([`list ${ADA}`]);
  });

  test('a live agent key opens the monitor but never this surface', async () => {
    setKeyMap([{ key: AGENT_KEY, agentId: 1 }]);
    try {
      expect((await call('GET', '/api/connectors', AGENT_KEY)).status).toBe(401);
      expect((await call('POST', '/api/connectors', AGENT_KEY, {})).status).toBe(
        401,
      );
      expect((await call('POST', '/api/tail', AGENT_KEY)).status).toBe(405);
    } finally {
      setKeyMap([]);
    }
    expect(calls).toEqual([]);
  });

  test('every write path is 401 without a session', async () => {
    for (const [method, path] of [
      ['POST', '/api/connectors'],
      ['POST', '/api/connectors/1/verify'],
      ['DELETE', '/api/connectors/1'],
    ] as const)
      expect([path, (await call(method, path)).status]).toEqual([path, 401]);
    expect(calls).toEqual([]);
  });
});

describe('the routing gates run before authentication', () => {
  test('OPTIONS is 204 with CORS and no token', async () => {
    const res = await call('OPTIONS', '/api/connectors');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(res.headers.get('access-control-allow-headers')).toContain(
      'Authorization',
    );
  });

  test('OPTIONS on a connector id is 204 too', async () => {
    expect((await call('OPTIONS', '/api/connectors/1/verify')).status).toBe(204);
  });

  test('a path under the prefix that is not a target is 404, not 401', async () => {
    for (const path of [
      '/api/connectors/abc',
      '/api/connectors/0',
      '/api/connectors/-1',
      '/api/connectors/1/tools',
      '/api/connectors/1/verify/again',
      '/api/connectors/99999999999',
    ]) {
      const res = await call('GET', path);
      expect([path, res.status]).toEqual([path, 404]);
      expect(await res.json()).toEqual({ error: 'no such connector' });
    }
    expect(calls).toEqual([]);
  });

  test('a wrong method on a real target is 405, not 401', async () => {
    for (const [method, path] of [
      ['PUT', '/api/connectors'],
      ['DELETE', '/api/connectors'],
      ['GET', '/api/connectors/1'],
      ['POST', '/api/connectors/1'],
      ['GET', '/api/connectors/1/verify'],
      ['DELETE', '/api/connectors/1/verify'],
    ] as const) {
      const res = await call(method, path);
      expect([method, path, res.status]).toEqual([method, path, 405]);
      expect(await res.json()).toEqual({ error: 'method not allowed' });
    }
    expect(calls).toEqual([]);
  });
});

describe('GET /api/connectors returns the wire shape', () => {
  test('a row carries its identity, its secret and its own json block', async () => {
    const res = await call('GET', '/api/connectors', session(ADA));
    expect(res.status).toBe(200);
    const wire = (await res.json()) as {
      connectors: WireConnector[];
      json: string;
    };
    expect(wire.connectors.map((c) => c.name)).toEqual(['linear', 'docs']);
    expect(wire.connectors[0]).toEqual({
      id: 1,
      name: 'linear',
      url: 'https://mcp.linear.app/mcp',
      transport: 'http',
      auth: 'header',
      header: 'Authorization',
      secret: 'Bearer lin_oauth_7f',
      json: JSON.stringify(
        {
          mcpServers: {
            linear: {
              type: 'http',
              url: 'https://mcp.linear.app/mcp',
              headers: { Authorization: 'Bearer lin_oauth_7f' },
            },
          },
        },
        null,
        2,
      ),
      verified: VERIFIED,
    });
  });

  test('a connector with no auth reports null and hides no headers block', async () => {
    const docs = (await listFor(ADA)).find((c) => c.name === 'docs');
    expect(docs?.auth).toBe('none');
    expect(docs?.header).toBeNull();
    expect(docs?.secret).toBeNull();
    expect(docs?.json).not.toContain('headers');
  });

  test('the combined json holds every connector of that user and nobody else', async () => {
    const res = await call('GET', '/api/connectors', session(ADA));
    const wire = (await res.json()) as { json: string };
    const servers = (JSON.parse(wire.json) as { mcpServers: Record<string, unknown> })
      .mcpServers;
    expect(Object.keys(servers)).toEqual(['linear', 'docs']);
  });

  test("another user's connectors are simply not there", async () => {
    const bobs = await listFor(BOB);
    expect(bobs.map((c) => c.name)).toEqual(['notion']);
    expect(JSON.stringify(bobs)).not.toContain('lin_oauth_7f');
  });

  test('a signed-in user with nothing gets an empty list, not a 404', async () => {
    const res = await call('GET', '/api/connectors', session('nobody@nowhere.dev'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connectors: [],
      json: '{\n  "mcpServers": {}\n}',
    });
  });

  test('the email is lowercased before it reaches the store', async () => {
    await call('GET', '/api/connectors', session('ADA@Lovelace.DEV'));
    expect(calls).toEqual([`list ${ADA}`]);
  });
});

describe('POST /api/connectors', () => {
  test('a created connector comes back in the list-row shape', async () => {
    const res = await call('POST', '/api/connectors', session(ADA), {
      name: 'sentry',
      url: 'https://mcp.sentry.dev/mcp',
      value: 'Bearer sntry_1',
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as WireConnector;
    expect(created).toMatchObject({
      name: 'sentry',
      transport: 'http',
      auth: 'header',
      header: 'Authorization',
      secret: 'Bearer sntry_1',
    });
    expect(JSON.parse(created.json)).toEqual({
      mcpServers: {
        sentry: {
          type: 'http',
          url: 'https://mcp.sentry.dev/mcp',
          headers: { Authorization: 'Bearer sntry_1' },
        },
      },
    });
    expect((await listFor(ADA)).map((c) => c.name)).toEqual([
      'linear',
      'docs',
      'sentry',
    ]);
  });

  test('a duplicate name for the same user is 409', async () => {
    const res = await call('POST', '/api/connectors', session(ADA), {
      name: 'linear',
      url: 'https://mcp.linear.app/mcp',
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({
      error: "you already have a connector named 'linear'",
    });
  });

  test('the same name under another owner is fine', async () => {
    const res = await call('POST', '/api/connectors', session(BOB), {
      name: 'linear',
      url: 'https://mcp.linear.app/mcp',
    });
    expect(res.status).toBe(201);
  });

  test('a name with a space is 400 — it would paste as two words', async () => {
    for (const name of ['my linear', '', 'a', '-leading', 'x'.repeat(33)]) {
      const res = await call('POST', '/api/connectors', session(ADA), {
        name,
        url: 'https://mcp.linear.app/mcp',
      });
      expect([name, res.status]).toEqual([name, 400]);
    }
  });

  test('a localhost url is 400 with the policy sentence, never a 500', async () => {
    for (const url of [
      'https://localhost/mcp',
      'https://127.0.0.1/mcp',
      'http://mcp.linear.app/mcp',
      'https://intranet/mcp',
    ]) {
      const res = await call('POST', '/api/connectors', session(ADA), {
        name: 'probe',
        url,
      });
      expect([url, res.status]).toEqual([url, 400]);
      expect(typeof ((await res.json()) as { error: string }).error).toBe('string');
    }
  });

  test('a remote refusing the credential is a 400, never metro 401', async () => {
    const res = await call('POST', '/api/connectors', session(ADA), {
      name: 'picky',
      url: 'https://rejects.example.com/mcp',
      value: 'Bearer wrong',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'rejects.example.com rejected that credential.',
    });
  });

  test('an unreachable remote is a 400, not a 502', async () => {
    const res = await call('POST', '/api/connectors', session(ADA), {
      name: 'gone',
      url: 'https://down.example.com/mcp',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Metro could not reach down.example.com.',
    });
  });

  test('a header with no value is 400', async () => {
    const res = await call('POST', '/api/connectors', session(ADA), {
      name: 'halfauth',
      url: 'https://mcp.example.com/mcp',
      header: 'Authorization',
    });
    expect(res.status).toBe(400);
  });

  test('the shared 4 KiB body cap applies here too', async () => {
    const res = await call('POST', '/api/connectors', session(ADA), {
      name: 'huge',
      url: 'https://mcp.example.com/mcp',
      value: `Bearer ${'x'.repeat(5000)}`,
    });
    expect(res.status).toBe(413);
    expect(calls).toEqual([]);
  });

  test('a body that is not JSON is 400, and nothing is created', async () => {
    const res = await fetch(`${base}/api/connectors`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session(ADA)}`,
        'content-type': 'application/json',
      },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('another owner is a 404, never a 403', () => {
  test("DELETE of somebody else's connector is 404", async () => {
    const res = await call('DELETE', '/api/connectors/3', session(ADA));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such connector' });
    expect((await listFor(BOB)).map((c) => c.id)).toEqual([3]);
  });

  test("verify of somebody else's connector is 404", async () => {
    const res = await call('POST', '/api/connectors/3/verify', session(ADA));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such connector' });
  });

  test('an id that exists and one that never did answer identically', async () => {
    const mine = await call('DELETE', '/api/connectors/3', session(ADA));
    const never = await call('DELETE', '/api/connectors/8888', session(ADA));
    expect([mine.status, never.status]).toEqual([404, 404]);
    expect(await mine.json()).toEqual(await never.json());
  });
});

describe('verify and delete', () => {
  test('a re-verify that succeeds is 200 with ok true', async () => {
    const res = await call('POST', '/api/connectors/1/verify', session(ADA));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: 1,
      name: 'linear',
      ok: true,
      verified: VERIFIED,
    });
  });

  test('a re-verify that fails is still 200, with ok false and a reason', async () => {
    rows = [
      ...SEED,
      {
        id: 4,
        email: ADA,
        name: 'picky',
        url: 'https://rejects.example.com/mcp',
        header: 'Authorization',
        secret: 'Bearer wrong',
      },
    ];
    const res = await call('POST', '/api/connectors/4/verify', session(ADA));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: 4,
      name: 'picky',
      ok: false,
      reason: 'rejects.example.com rejected that credential.',
    });
  });

  test('DELETE removes the row and names it back', async () => {
    const res = await call('DELETE', '/api/connectors/1', session(ADA));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1, name: 'linear', deleted: true });
    expect((await listFor(ADA)).map((c) => c.name)).toEqual(['docs']);
  });

  test('deleting twice is a 404 the second time', async () => {
    expect((await call('DELETE', '/api/connectors/2', session(ADA))).status).toBe(
      200,
    );
    expect((await call('DELETE', '/api/connectors/2', session(ADA))).status).toBe(
      404,
    );
  });
});

describe('the mounting order inside handlePreMcpRoutes', () => {
  test('the monitor router claims /api/* and must not swallow this one', async () => {
    expect((await fetch(`${base}/api/tail`)).status).toBe(401);
    const res = await call('GET', '/api/connectors', session(ADA));
    expect(res.status).toBe(200);
    expect((await res.json()) as { connectors: unknown[] }).toHaveProperty(
      'connectors',
    );
  });

  test('the monitor really is armed — its own unauthenticated health answers', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({
      ok: true,
      service: 'metro',
    });
  });

  test('/health still 200s in front of everything', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  test('the connector prefix does not shadow the monitor call route', async () => {
    const res = await fetch(`${base}/api/call/telegram/send`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  test('a path merely starting with the prefix text is not claimed', async () => {
    expect((await fetch(`${base}/api/connectorsxyz`)).status).toBe(401);
  });
});
