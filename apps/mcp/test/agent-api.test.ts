import { afterEach, beforeAll, afterAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { signSession } from '../src/daemon/session.ts';
import { mcpAddCommand, type AgentApiDeps } from '../src/daemon/agent-api.ts';
import {
  AgentAdminError,
  normalizeAgentName,
  type AgentSummary,
  type DeletedAgent,
} from '../src/db/agent-admin.ts';

const SECRET = 'agent-api-test-secret';
const PUBLIC = 'https://mcp.metro.box';

const fakeKey = (agent: string): string => `mk_fake_${agent}`;

const defaultKey = (agent: string): AgentSummary['keys'] => [
  { name: 'default', key: fakeKey(agent) },
];

const OWNED: Record<string, AgentSummary[]> = {
  'ada@lovelace.dev': [
    { id: 1, name: 'ada-bot', owned: true, keys: defaultKey('ada-bot') },
  ],
  'bob@builder.dev': [
    { id: 2, name: 'bob-bot', owned: true, keys: defaultKey('bob-bot') },
  ],
  'ada@same.dev': [{ id: 7, name: 'tony', owned: true, keys: defaultKey('ada-tony') }],
  'bob@same.dev': [{ id: 8, name: 'tony', owned: true, keys: defaultKey('bob-tony') }],
};

let leakGrantedKeys = false;

const ACCOUNTS_BY_AGENT_ID: Record<number, [string, unknown]> = {
  1: ['telegram', { id: 'ada-tg', owner: 'ada' }],
  2: ['discord', { id: 'bob-dc', owner: 'bob' }],
  7: ['telegram', { id: 'ada-tony-tg', owner: 'ada' }],
  8: ['telegram', { id: 'bob-tony-tg', owner: 'bob' }],
};

interface Row {
  id: number;
  name: string;
  ownerEmail: string | null;
}

const SEED: Row[] = [
  { id: 1, name: 'ada-bot', ownerEmail: 'ada@lovelace.dev' },
  { id: 2, name: 'bob-bot', ownerEmail: 'bob@builder.dev' },
  { id: 5, name: 'legacy', ownerEmail: null },
];

let server: Server;
let base: string;
let scopes: Set<number>[] = [];
let created: { email: string; name: string }[] = [];
let rows: Row[] = [...SEED];
let deleteCalls: { email: string; granted: string[]; id: number }[] = [];
let nextId = 10;

function removeAgent(email: string, granted: string[], id: number): DeletedAgent {
  deleteCalls.push({ email, granted, id });
  const row = rows.find((r) => r.id === id);
  if (!row) throw new AgentAdminError('no such agent', 404);
  if (row.ownerEmail === null) {
    if (!granted.includes(row.name)) throw new AgentAdminError('no such agent', 404);
    throw new AgentAdminError('operator-provisioned agents cannot be deleted here', 403);
  }
  if (row.ownerEmail !== email) throw new AgentAdminError('no such agent', 404);
  rows = rows.filter((r) => r.id !== id);
  return { id: row.id, name: row.name };
}

const deps: AgentApiDeps = {
  listAgents: (email, granted) =>
    Promise.resolve([
      ...(OWNED[email] ?? []),
      ...granted.map((name, i) => ({
        id: 900 + i,
        name,
        owned: false,
        keys: leakGrantedKeys ? defaultKey(name) : [],
      })),
    ]),
  createAgent: (email, name) => {
    const clean = normalizeAgentName(name);
    if (clean === 'taken')
      return Promise.reject(new AgentAdminError("agent name 'taken' is already taken", 409));
    created.push({ email, name: clean });
    nextId += 1;
    return Promise.resolve({ id: nextId, name: clean, key: `mk_key_for_${clean}` });
  },
  deleteAgent: (email, granted, id) => {
    try {
      return Promise.resolve(removeAgent(email, granted, id));
    } catch (e) {
      return Promise.reject(e as Error);
    }
  },
  gatherAccounts: (allowed) => {
    scopes.push(allowed);
    const out: Record<string, unknown[]> = { telegram: [], discord: [] };
    for (const id of allowed) {
      const hit = ACCOUNTS_BY_AGENT_ID[id];
      if (hit) (out[hit[0]] as unknown[]).push(hit[1]);
    }
    return Promise.resolve(out);
  },
  capabilities: () => ({ telegram: ['send'], discord: ['send', 'read'] }),
};

const session = (email: string, secret = SECRET): string =>
  signSession({ email, agentIds: [] }, secret);

const get = (token?: string): Promise<Response> =>
  fetch(`${base}/api/agents`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

const post = (token: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const del = (token: string | undefined, path: string): Promise<Response> =>
  fetch(`${base}/api/agents/${path}`, {
    method: 'DELETE',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

beforeAll(async () => {
  process.env.METRO_SESSION_SECRET = SECRET;
  process.env.METRO_PUBLIC_URL = PUBLIC;
  delete process.env.GOOGLE_EMAIL_AGENTS;
  process.env.METRO_WEBHOOK_PORT = String(20000 + Math.floor(Math.random() * 20000));
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  server = await startWebhookServer(makeEmit(), undefined, undefined, deps);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.METRO_SESSION_SECRET;
  delete process.env.METRO_PUBLIC_URL;
});

afterEach(() => {
  scopes = [];
  created = [];
  rows = [...SEED];
  deleteCalls = [];
  leakGrantedKeys = false;
  delete process.env.GOOGLE_EMAIL_AGENTS;
});

describe('/api/agents authentication', () => {
  test('no token is 401', async () => {
    expect((await get()).status).toBe(401);
  });

  test('a session signed with another secret is 401', async () => {
    expect((await get(session('ada@lovelace.dev', 'other-secret'))).status).toBe(401);
  });

  test('an expired session is 401', async () => {
    const stale = signSession({ email: 'ada@lovelace.dev', agentIds: [] }, SECRET, {
      ttlSec: -10,
    });
    expect((await get(stale)).status).toBe(401);
  });

  test('a ?token= query param authenticates too', async () => {
    const res = await fetch(
      `${base}/api/agents?token=${encodeURIComponent(session('ada@lovelace.dev'))}`,
    );
    expect(res.status).toBe(200);
  });

  test('OPTIONS preflight is 204 with CORS', async () => {
    const res = await fetch(`${base}/api/agents`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  test('DELETE on the collection is 405 — deletion is per-agent-id only', async () => {
    const res = await fetch(`${base}/api/agents`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${session('ada@lovelace.dev')}` },
    });
    expect(res.status).toBe(405);
    expect(deleteCalls).toEqual([]);
  });
});

interface WireKey {
  name: string;
  key: string | null;
  endpoint: string | null;
  command: string | null;
}

interface WireAgent {
  id: number;
  name: string;
  owned: boolean;
  keys: WireKey[];
}

interface ListBody {
  email: string;
  endpoint: string;
  agents: WireAgent[];
  accounts: Record<string, unknown[]>;
}

const listAgents = async (email: string): Promise<WireAgent[]> =>
  ((await (await get(session(email))).json()) as ListBody).agents;

describe('GET /api/agents ownership', () => {
  test('returns only the caller own agents and their accounts', async () => {
    const res = await get(session('ada@lovelace.dev'));
    const body = (await res.json()) as ListBody;
    expect(body.email).toBe('ada@lovelace.dev');
    expect(body.endpoint).toBe(`${PUBLIC}/mcp`);
    expect(body.agents.map((a) => a.name)).toEqual(['ada-bot']);
    expect(body.accounts.telegram).toEqual([{ id: 'ada-tg', owner: 'ada' }]);
    expect(body.accounts.discord).toEqual([]);
  });

  test('another signed-in user never sees the first user agent', async () => {
    const body = (await (await get(session('bob@builder.dev'))).json()) as ListBody;
    expect(body.agents.map((a) => a.name)).toEqual(['bob-bot']);
    expect(body.accounts.telegram).toEqual([]);
    expect(body.accounts.discord).toEqual([{ id: 'bob-dc', owner: 'bob' }]);
  });

  test('the accounts scope set is exactly the visible agent IDS, never names', async () => {
    await get(session('ada@lovelace.dev'));
    expect(scopes.at(-1)).toEqual(new Set([1]));
  });

  test('two owners whose agents share a name each see only their own accounts', async () => {
    const ada = (await (await get(session('ada@same.dev'))).json()) as ListBody;
    const adaScope = scopes.at(-1);
    const bob = (await (await get(session('bob@same.dev'))).json()) as ListBody;
    const bobScope = scopes.at(-1);

    expect(ada.agents.map((a) => a.name)).toEqual(['tony']);
    expect(bob.agents.map((a) => a.name)).toEqual(['tony']);
    expect(adaScope).toEqual(new Set([7]));
    expect(bobScope).toEqual(new Set([8]));
    expect(ada.accounts.telegram).toEqual([{ id: 'ada-tony-tg', owner: 'ada' }]);
    expect(bob.accounts.telegram).toEqual([{ id: 'bob-tony-tg', owner: 'bob' }]);
  });

  test('a brand-new signed-in user sees no agents and no accounts', async () => {
    const body = (await (await get(session('nobody@example.com'))).json()) as ListBody;
    expect(body.agents).toEqual([]);
    expect(scopes.at(-1)).toEqual(new Set());
    expect(body.accounts.telegram).toEqual([]);
  });

  test('GOOGLE_EMAIL_AGENTS grants show up as not-owned', async () => {
    process.env.GOOGLE_EMAIL_AGENTS = '{"nobody@example.com":["legacy"]}';
    const body = (await (await get(session('nobody@example.com'))).json()) as ListBody;
    expect(body.agents).toEqual([{ id: 900, name: 'legacy', owned: false, keys: [] }]);
    expect(scopes.at(-1)).toEqual(new Set([900]));
  });

  test('the session email is compared case-insensitively', async () => {
    const body = (await (await get(session('ADA@Lovelace.dev'))).json()) as ListBody;
    expect(body.agents.map((a) => a.name)).toEqual(['ada-bot']);
  });

  test('responses are marked no-store', async () => {
    const res = await get(session('ada@lovelace.dev'));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /api/agents key exposure', () => {
  test('an owned agent carries its key, tokenised endpoint and paste-ready command', async () => {
    const [agent] = await listAgents('ada@lovelace.dev');
    expect(agent?.keys).toEqual([
      {
        name: 'default',
        key: 'mk_fake_ada-bot',
        endpoint: `${PUBLIC}/mcp?token=mk_fake_ada-bot`,
        command: `claude mcp add --transport http --scope user ada-bot "${PUBLIC}/mcp?token=mk_fake_ada-bot"`,
      },
    ]);
  });

  test('the listed command matches what POST hands back for the same key', async () => {
    const [agent] = await listAgents('ada@lovelace.dev');
    expect(agent?.keys[0]?.command).toBe(mcpAddCommand('ada-bot', 'mk_fake_ada-bot'));
  });

  test('another signed-in user never receives the first user key', async () => {
    const body = await (await get(session('bob@builder.dev'))).text();
    expect(body).not.toContain('mk_fake_ada-bot');
  });

  test('a granted agent is listed with its key names but no key value', async () => {
    process.env.GOOGLE_EMAIL_AGENTS = '{"nobody@example.com":["legacy"]}';
    leakGrantedKeys = true;
    const [agent] = await listAgents('nobody@example.com');
    expect(agent?.owned).toBe(false);
    expect(agent?.keys).toEqual([
      { name: 'default', key: null, endpoint: null, command: null },
    ]);
  });

  test('a key value that reaches the api layer for a not-owned agent is still not served', async () => {
    process.env.GOOGLE_EMAIL_AGENTS = '{"nobody@example.com":["legacy"]}';
    leakGrantedKeys = true;
    const body = await (await get(session('nobody@example.com'))).text();
    expect(body).toContain('legacy');
    expect(body).not.toContain('mk_fake_legacy');
  });

  test('a grantee sees no key even when they also own an agent', async () => {
    process.env.GOOGLE_EMAIL_AGENTS = '{"ada@lovelace.dev":["legacy"]}';
    leakGrantedKeys = true;
    const agents = await listAgents('ada@lovelace.dev');
    expect(agents.map((a) => [a.name, a.keys[0]?.key])).toEqual([
      ['ada-bot', 'mk_fake_ada-bot'],
      ['legacy', null],
    ]);
  });
});

interface CreateBody {
  id: number;
  name: string;
  key: string;
  endpoint: string;
  command: string;
  error?: string;
}

describe('POST /api/agents', () => {
  test('creates the agent for the session email and returns the key once', async () => {
    const res = await post(session('ada@lovelace.dev'), { name: 'Fresh-Agent' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateBody;
    expect(body.name).toBe('fresh-agent');
    expect(body.key).toBe('mk_key_for_fresh-agent');
    expect(created).toEqual([{ email: 'ada@lovelace.dev', name: 'fresh-agent' }]);
  });

  test('returns the exact endpoint and claude mcp add command to paste', async () => {
    const body = (await (
      await post(session('ada@lovelace.dev'), { name: 'pasteme' })
    ).json()) as CreateBody;
    expect(body.endpoint).toBe(`${PUBLIC}/mcp?token=mk_key_for_pasteme`);
    expect(body.command).toBe(
      `claude mcp add --transport http --scope user pasteme "${PUBLIC}/mcp?token=mk_key_for_pasteme"`,
    );
  });

  test('the agent is always created for the session email, never a body-supplied one', async () => {
    await post(session('bob@builder.dev'), {
      name: 'sneaky',
      email: 'ada@lovelace.dev',
      ownerEmail: 'ada@lovelace.dev',
    });
    expect(created).toEqual([{ email: 'bob@builder.dev', name: 'sneaky' }]);
  });

  test('an invalid name is 400 and creates nothing', async () => {
    const res = await post(session('ada@lovelace.dev'), { name: 'no spaces' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as CreateBody).error).toContain('name must be');
    expect(created).toEqual([]);
  });

  test('a missing name is 400', async () => {
    expect((await post(session('ada@lovelace.dev'), {})).status).toBe(400);
  });

  test('a taken name is 409', async () => {
    const res = await post(session('ada@lovelace.dev'), { name: 'taken' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as CreateBody).error).toContain('already taken');
  });

  test('a non-JSON body is 400', async () => {
    const res = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session('ada@lovelace.dev')}` },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  test('creating without a session is 401 and creates nothing', async () => {
    const res = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'anon' }),
    });
    expect(res.status).toBe(401);
    expect(created).toEqual([]);
  });
});

describe('DELETE /api/agents/:id', () => {
  test('an owner deletes their own agent by id', async () => {
    const res = await del(session('ada@lovelace.dev'), '1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1, name: 'ada-bot', deleted: true });
    expect(rows.map((r) => r.id)).toEqual([2, 5]);
  });

  test('deleting someone else agent id is refused and leaves it intact', async () => {
    const res = await del(session('ada@lovelace.dev'), '2');
    expect(res.status).toBe(404);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 5]);
    expect(deleteCalls).toEqual([
      { email: 'ada@lovelace.dev', granted: [], id: 2 },
    ]);
  });

  test('an operator row is refused even when the session can see it', async () => {
    process.env.GOOGLE_EMAIL_AGENTS = '{"ada@lovelace.dev":["legacy"]}';
    const res = await del(session('ada@lovelace.dev'), '5');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain(
      'operator-provisioned',
    );
    expect(rows.map((r) => r.id)).toEqual([1, 2, 5]);
  });

  test('an operator row the session cannot see is a plain 404', async () => {
    const res = await del(session('ada@lovelace.dev'), '5');
    expect(res.status).toBe(404);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 5]);
  });

  test('the owner is always the session email, never anything from the request', async () => {
    await del(session('ADA@Lovelace.dev'), '1');
    expect(deleteCalls).toEqual([
      { email: 'ada@lovelace.dev', granted: [], id: 1 },
    ]);
  });

  test('deleting without a session is 401 and deletes nothing', async () => {
    expect((await del(undefined, '1')).status).toBe(401);
    expect(deleteCalls).toEqual([]);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 5]);
  });

  test('a session signed with another secret deletes nothing', async () => {
    const res = await del(session('ada@lovelace.dev', 'other-secret'), '1');
    expect(res.status).toBe(401);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 5]);
  });

  test('a non-numeric or malformed id never reaches the database', async () => {
    for (const bad of ['abc', '0', '-1', '1.5', '1%20OR%201', 'ada-bot']) {
      expect((await del(session('ada@lovelace.dev'), bad)).status).toBe(404);
    }
    expect(deleteCalls).toEqual([]);
  });

  test('an unknown id is 404', async () => {
    expect((await del(session('ada@lovelace.dev'), '9999')).status).toBe(404);
  });

  test('GET and POST on a single agent are 405', async () => {
    const token = session('ada@lovelace.dev');
    const headers = { authorization: `Bearer ${token}` };
    expect((await fetch(`${base}/api/agents/1`, { headers })).status).toBe(405);
    expect(
      (await fetch(`${base}/api/agents/1`, { method: 'POST', headers })).status,
    ).toBe(405);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 5]);
  });

  test('OPTIONS preflight on a single agent advertises DELETE', async () => {
    const res = await fetch(`${base}/api/agents/1`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
  });

  test('a second agent of the same owner survives the delete', async () => {
    rows = [
      ...SEED,
      { id: 6, name: 'ada-second', ownerEmail: 'ada@lovelace.dev' },
    ];
    expect((await del(session('ada@lovelace.dev'), '1')).status).toBe(200);
    expect(rows.map((r) => r.id)).toEqual([2, 5, 6]);
  });
});
