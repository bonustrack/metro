import { auth, bearer, forged, type Who } from './identity-helper.ts';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { bootDaemon, type Daemon } from './http-harness.ts';
import { ApiError } from '@metro-labs/http/api-error';
import {
  ConnectorVerifyError,
  parseConnectorUrl,
} from '../src/connectors/verify.ts';
import type { ConnectorApiDeps } from '../src/connectors/api.ts';
import { setKeyMap } from '../src/agents/keys.ts';

const ADA = 'ada@lovelace.dev';
const CLASHES_IN_AGENT = 'already-on-suzy';

const AGENT_KEY = 'mk_connector_surface_probe';

const NAME_RE = /^.{1,64}$/;

interface ConnectorInput {
  name: unknown;
  url: unknown;
  header: unknown;
  value: unknown;
}

interface Row {
  id: string;
  name: string;
  url: string;
  header: string | null;
  secret: string | null;
  signIn?: 'connected' | 'disconnected' | null;
}

interface WireConnector {
  id: string;
  name: string;
  url: string;
  auth: string;
  header: string | null;
  secret: string | null;
  signIn: 'connected' | 'disconnected' | null;
  json: string;
  verified: {
    at: string;
    server: string;
  };
}

const SEED: Row[] = [
  {
    id: 'agent000001',
    name: 'linear',
    url: 'https://mcp.linear.app/mcp',
    header: 'Authorization',
    secret: 'Bearer lin_oauth_7f',
  },
  {
    id: 'agent000002',
    name: 'docs',
    url: 'https://docs.example.com/mcp',
    header: null,
    secret: null,
  },
];

let daemon: Daemon;
let base: string;
let rows: Row[] = [...SEED];
let nextId = 10;
let calls: string[] = [];

const VERIFIED = {
  at: '2026-08-21T09:14:04.880Z',
  server: 'linear',
};

const toConnector = (row: Row) => ({
  id: row.id,
  name: row.name,
  url: row.url,
  auth: row.secret === null ? 'none' : 'header',
  header: row.header,
  secret: row.secret,
  signIn: row.signIn ?? null,
  verified: VERIFIED,
});

const missing = (): ApiError => new ApiError('no such connector', 404);

function rowOrThrow(id: string): Row {
  const row = rows.find((r) => r.id === id);
  if (row === undefined) throw missing();
  return row;
}

function makeRow(input: ConnectorInput): Row {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!NAME_RE.test(name))
    throw new ApiError(
      'a connector needs a name',
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
  nextId += 1;
  return {
    id: String(nextId),
    name,
    url: url.toString(),
    header: value === null ? null : (header ?? 'Authorization'),
    secret: value,
  };
}

const deps: ConnectorApiDeps = {
  listConnectors: async () => {
    calls.push('list');
    return rows.map(toConnector);
  },
  createConnector: async (input) => {
    calls.push('create');
    const row = makeRow(input);
    rows.push(row);
    return toConnector(row);
  },
  connectorTools: async (id) => {
    rowOrThrow(id);
    return [{ name: 'create_issue', description: 'Files an issue', readOnly: false }];
  },
  verifyConnector: async (id) => {
    calls.push(`verify ${id}`);
    const row = rowOrThrow(id);
    if (row.url.includes('rejects.example.com'))
      return {
        id: row.id,
        name: row.name,
        ok: false,
        reason: 'rejects.example.com rejected that credential.',
      };
    return { id: row.id, name: row.name, ok: true, verified: VERIFIED };
  },
  getConnector: async (id) => {
    calls.push(`get ${id}`);
    return toConnector(rowOrThrow(id));
  },
  disconnectConnector: async (id) => {
    calls.push(`disconnect ${id}`);
    const row = rowOrThrow(id);
    const next: Row = { ...row, header: null, secret: null, signIn: null };
    rows = rows.map((r) => (r.id === id ? next : r));
    return toConnector(next);
  },
  renameConnector: async (id, name) => {
    calls.push(`rename ${id} ${name}`);
    const row = rowOrThrow(id);
    if (name === CLASHES_IN_AGENT)
      throw new ApiError(
        `the agent 'suzy' already has a connector named '${name}'`,
        409,
      );
    const next: Row = { ...row, name };
    rows = rows.map((r) => (r.id === id ? next : r));
    return toConnector(next);
  },
  deleteConnector: async (id) => {
    calls.push(`delete ${id}`);
    const row = rowOrThrow(id);
    rows = rows.filter((r) => r.id !== id);
    return { id: row.id, name: row.name };
  },
};


const call = async (
  method: string,
  path: string,
  token?: Who,
  body?: unknown,
): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: await auth(token) }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const keyed = (method: string, path: string, key: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const listFor = async (email: string): Promise<WireConnector[]> => {
  const res = await call('GET', '/api/connectors', email);
  const wire = (await res.json()) as { connectors: WireConnector[] };
  return wire.connectors;
};

beforeAll(async () => {
  daemon = await bootDaemon({ connectorApi: deps }, { monitor: true });
  base = daemon.base;
});

afterAll(async () => {
  await daemon.close();
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

  test('a token nobody issued is 401', async () => {
    const res = await fetch(`${base}/api/connectors`, { headers: { authorization: await forged(ADA) } });
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test('a token with no organization is 401', async () => {
    const res = await fetch(`${base}/api/connectors`, { headers: { authorization: await bearer({ org_id: undefined }) } });
    expect(res.status).toBe(401);
  });

  test('a ?token= query param never authenticates a browser', async () => {
    const res = await fetch(`${base}/api/connectors?token=${AGENT_KEY}`);
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test('a live agent key opens the monitor but never this surface', async () => {
    setKeyMap([{ key: AGENT_KEY, agentId: 'agent000001' }]);
    try {
      expect((await keyed('GET', '/api/connectors', AGENT_KEY)).status).toBe(401);
      expect((await keyed('POST', '/api/connectors', AGENT_KEY, {})).status).toBe(401);
      expect((await keyed('POST', '/api/tail', AGENT_KEY)).status).toBe(405);
    } finally {
      setKeyMap([]);
    }
    expect(calls).toEqual([]);
  });

  test('every write path is 401 without a session', async () => {
    for (const [method, path] of [
      ['POST', '/api/connectors'],
      ['POST', '/api/connectors/agent000001/verify'],
      ['DELETE', '/api/connectors/agent000001'],
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
    expect((await call('OPTIONS', '/api/connectors/agent000001/verify')).status).toBe(204);
  });

  test('a path under the prefix that is not a target is 404, not 401', async () => {
    for (const path of [
      '/api/connectors/abc',
      '/api/connectors/nope',
      '/api/connectors/-1',
      '/api/connectors/agent000001/catalog',
      '/api/connectors/agent000001/verify/again',
      '/api/connectors/agent99999999999',
    ]) {
      const res = await call('GET', path);
      expect([path, res.status]).toEqual([path, 404]);
      expect(await res.json()).toEqual({ error: 'no such connector' });
    }
    expect(calls).toEqual([]);
  });

  test('GET on a connector is a real route now — it reaches auth, not 405', async () => {
    const res = await fetch(`${base}/api/connectors/agent000001`);
    expect(res.status).toBe(401);
  });

  test('a wrong method on a real target is 405, not 401', async () => {
    for (const [method, path] of [
      ['PUT', '/api/connectors'],
      ['DELETE', '/api/connectors'],
      ['POST', '/api/connectors/agent000001'],
      ['PUT', '/api/connectors/agent000001'],
      ['GET', '/api/connectors/agent000001/verify'],
      ['DELETE', '/api/connectors/agent000001/verify'],
      ['GET', '/api/connectors/agent000001/connect'],
      ['DELETE', '/api/connectors/agent000001/connect'],
      ['GET', '/api/connectors/agent000001/disconnect'],
      ['DELETE', '/api/connectors/agent000001/disconnect'],
    ] as const) {
      const res = await call(method, path);
      expect([method, path, res.status]).toEqual([method, path, 405]);
      expect(await res.json()).toEqual({ error: 'method not allowed' });
    }
    expect(calls).toEqual([]);
  });

  test('a sub-path that is not a real action is a 404, decided before auth', async () => {
    for (const path of [
      '/api/connectors/agent000001/nonsense',
      '/api/connectors/agent000001/verify/extra',
      '/api/connectors/agent000001/connect/now',
    ]) {
      const res = await fetch(`${base}${path}`, { method: 'POST' });
      expect([path, res.status]).toEqual([path, 404]);
      expect(await res.json()).toEqual({ error: 'no such connector' });
    }
    expect(calls).toEqual([]);
  });
});

describe('a connector can be signed out without being deleted', () => {
  test('disconnect reaches the writer and answers with the row, not a deletion', async () => {
    const res = await call('POST', '/api/connectors/agent000001/disconnect', ADA);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: 'agent000001',
      name: 'linear',
      signIn: null,
    });
    expect(calls).toEqual(['disconnect agent000001']);
    expect(rows.some((r) => r.id === 'agent000001')).toBe(true);
  });

  test('the row it answers with reports no auth left', async () => {
    const res = await call('POST', '/api/connectors/agent000001/disconnect', ADA);
    expect(await res.json()).toMatchObject({ header: null, signIn: null });
  });

  test('disconnect is session-gated, never open to an agent key', async () => {
    const bare = await call('POST', '/api/connectors/agent000001/disconnect');
    const withKey = await keyed('POST', '/api/connectors/agent000001/disconnect', AGENT_KEY);
    expect([bare.status, withKey.status]).toEqual([401, 401]);
    expect(calls).toEqual([]);
  });

  test('a signed-in row reports connected, so the page can offer Disconnect', async () => {
    rows = rows.map((r) =>
      r.id === 'agent000002' ? { ...r, signIn: 'connected' as const } : r,
    );
    const res = await call('GET', '/api/connectors', ADA);
    const body = (await res.json()) as { connectors: { id: string; signIn: unknown }[] };
    const seen = body.connectors.map((c) => [c.id, c.signIn]);
    expect(seen).toEqual([
      ['agent000001', null],
      ['agent000002', 'connected'],
    ]);
  });
});

describe('GET /api/connectors returns the wire shape', () => {
  test('a row carries its identity and nothing that could sign anything in', async () => {
    const res = await call('GET', '/api/connectors', ADA);
    expect(res.status).toBe(200);
    const wire = (await res.json()) as {
      connectors: WireConnector[];
      json?: string;
    };
    expect(wire.connectors.map((c) => c.name)).toEqual(['linear', 'docs']);
    expect(wire.connectors[0]).toEqual({
      id: 'agent000001',
      name: 'linear',
      url: 'https://mcp.linear.app/mcp',
      auth: 'header',
      header: 'Authorization',
      clientId: null,
      signIn: null,
      verified: VERIFIED,
      health: null,
    });
  });

  test('the tools of a connector are listed live', async () => {
    const mine = await call('GET', '/api/connectors/agent000001/tools', ADA);
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual({ tools: [{ name: 'create_issue', description: 'Files an issue', readOnly: false }] });
    expect((await call('POST', '/api/connectors/agent000001/tools', ADA)).status).toBe(405);
  });

  test('a connector with no auth reports null', async () => {
    const docs = (await listFor(ADA)).find((c) => c.name === 'docs');
    expect(docs?.auth).toBe('none');
    expect(docs?.header).toBeNull();
  });

  test('a browser session gets no credential anywhere in the response', async () => {
    const res = await call('GET', '/api/connectors', ADA);
    const body = await res.text();
    expect(body).not.toContain('lin_oauth_7f');
    expect(body).not.toContain('mcpServers');
    expect(JSON.parse(body) as { json?: string }).not.toHaveProperty('json');
  });
});

describe('a connector can be renamed', () => {
  test('the row comes back under its new name', async () => {
    const res = await call('POST', '/api/connectors/agent000001/rename', ADA, {
      name: 'Linear · prod',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'agent000001', name: 'Linear · prod' });
    expect((await listFor(ADA)).map((c) => c.name)).toContain('Linear · prod');
  });

  test('a name another of yours already has is fine, names are unique per agent', async () => {
    const res = await call('POST', '/api/connectors/agent000001/rename', ADA, {
      name: 'docs',
    });
    expect(res.status).toBe(200);
    expect((await listFor(ADA)).filter((c) => c.name === 'docs')).toHaveLength(2);
  });

  test('a name that would collide on an agent is 409, not a silent overwrite', async () => {
    const res = await call('POST', '/api/connectors/agent000001/rename', ADA, {
      name: CLASHES_IN_AGENT,
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({
      error: `the agent 'suzy' already has a connector named '${CLASHES_IN_AGENT}'`,
    });
  });

  test('renaming a connector that is not there is 404', async () => {
    expect((await call('POST', '/api/connectors/agent999999/rename', ADA, { name: 'x' })).status).toBe(404);
  });

  test('a missing or non-string name is a 400 before the store is touched', async () => {
    calls.length = 0;
    for (const body of [{}, { name: 7 }, { name: null }])
      expect(
        (await call('POST', '/api/connectors/agent000001/rename', ADA, body))
          .status,
      ).toBe(400);
    expect(calls).toEqual([]);
  });

  test('rename needs a session, and GET is refused', async () => {
    expect(
      (await call('POST', '/api/connectors/agent000001/rename', undefined, { name: 'x' }))
        .status,
    ).toBe(401);
    expect((await call('GET', '/api/connectors/agent000001/rename', ADA)).status).toBe(405);
  });
});

describe('POST /api/connectors', () => {
  test('a created connector comes back in the list-row shape', async () => {
    const res = await call('POST', '/api/connectors', ADA, {
      name: 'sentry',
      url: 'https://mcp.sentry.dev/mcp',
      value: 'Bearer sntry_1',
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as WireConnector;
    expect(created).toMatchObject({
      name: 'sentry',
      auth: 'header',
      header: 'Authorization',
    });
    expect((await listFor(ADA)).map((c) => c.name)).toEqual([
      'linear',
      'docs',
      'sentry',
    ]);
  });

  test('a name is a label now — spaces and punctuation are accepted', async () => {
    for (const name of ['my linear', 'a', '-leading', 'Snapshot · prod']) {
      const res = await call('POST', '/api/connectors', ADA, {
        name,
        url: `https://${name.length}.example.com/mcp`,
      });
      expect([name, res.status]).toEqual([name, 201]);
    }
  });

  test('a name still has to be there, and cannot run on forever', async () => {
    for (const name of ['', '   ', 'x'.repeat(65)]) {
      const res = await call('POST', '/api/connectors', ADA, {
        name,
        url: 'https://mcp.linear.app/mcp',
      });
      expect([name, res.status]).toEqual([name, 400]);
    }
  });

  test('a malformed url is 400 with a sentence, never a 500', async () => {
    for (const url of [
      'ws://mcp.linear.app/mcp',
      'https://user:pass@mcp.linear.app/mcp',
      'https://mcp.linear.app/mcp#tools',
      'not a url',
    ]) {
      const res = await call('POST', '/api/connectors', ADA, {
        name: 'probe',
        url,
      });
      expect([url, res.status]).toEqual([url, 400]);
      expect(typeof ((await res.json()) as { error: string }).error).toBe('string');
    }
  });

  test('a remote refusing the credential is a 400, never metro 401', async () => {
    const res = await call('POST', '/api/connectors', ADA, {
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
    const res = await call('POST', '/api/connectors', ADA, {
      name: 'gone',
      url: 'https://down.example.com/mcp',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Metro could not reach down.example.com.',
    });
  });

  test('a header with no value is 400', async () => {
    const res = await call('POST', '/api/connectors', ADA, {
      name: 'halfauth',
      url: 'https://mcp.example.com/mcp',
      header: 'Authorization',
    });
    expect(res.status).toBe(400);
  });

  test('the shared 4 KiB body cap applies here too', async () => {
    const res = await call('POST', '/api/connectors', ADA, {
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
        authorization: await auth(ADA),
        'content-type': 'application/json',
      },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('verify and delete', () => {
  test('a re-verify that succeeds is 200 with ok true', async () => {
    const res = await call('POST', '/api/connectors/agent000001/verify', ADA);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: 'agent000001',
      name: 'linear',
      ok: true,
      verified: VERIFIED,
    });
  });

  test('a re-verify that fails is still 200, with ok false and a reason', async () => {
    rows = [
      ...SEED,
      {
        id: 'agent000004',
            name: 'picky',
        url: 'https://rejects.example.com/mcp',
        header: 'Authorization',
        secret: 'Bearer wrong',
      },
    ];
    const res = await call('POST', '/api/connectors/agent000004/verify', ADA);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: 'agent000004',
      name: 'picky',
      ok: false,
      reason: 'rejects.example.com rejected that credential.',
    });
  });

  test('DELETE removes the row and names it back', async () => {
    const res = await call('DELETE', '/api/connectors/agent000001', ADA);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'agent000001', name: 'linear', deleted: true });
    expect((await listFor(ADA)).map((c) => c.name)).toEqual(['docs']);
  });

  test('deleting twice is a 404 the second time', async () => {
    expect((await call('DELETE', '/api/connectors/agent000002', ADA)).status).toBe(
      200,
    );
    expect((await call('DELETE', '/api/connectors/agent000002', ADA)).status).toBe(
      404,
    );
  });
});

describe('the mounting order inside handlePreMcpRoutes', () => {
  beforeAll(() => {
    setKeyMap([{ key: AGENT_KEY, agentId: 'agent000001' }]);
  });
  afterAll(() => {
    setKeyMap([]);
  });

  test('the monitor router claims /api/* and must not swallow this one', async () => {
    expect((await fetch(`${base}/api/tail`)).status).toBe(401);
    const res = await call('GET', '/api/connectors', ADA);
    expect(res.status).toBe(200);
    expect((await res.json()) as { connectors: unknown[] }).toHaveProperty(
      'connectors',
    );
  });

  test('the monitor really is armed: the tail answers 401 without a key', async () => {
    expect((await fetch(`${base}/api/tail`)).status).toBe(401);
  });

  test('/health still 200s in front of everything', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  test('the connector prefix does not shadow the monitor route', async () => {
    expect((await fetch(`${base}/api/tail`)).status).toBe(401);
  });

  test('a path merely starting with the prefix text is not claimed', async () => {
    expect((await fetch(`${base}/api/connectorsxyz`)).status).toBe(401);
  });
});
