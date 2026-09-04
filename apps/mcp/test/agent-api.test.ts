import { afterEach, beforeAll, afterAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { signSession } from '../src/daemon/session.ts';
import { mcpAddCommand, type AgentApiDeps } from '../src/daemon/agent-api.ts';

const PORT = (): string => process.env.METRO_WEBHOOK_PORT ?? '8420';
import {
  AgentAdminError,
  normalizeAgentName,
  type AgentSummary,
  type DeletedAgent,
  type ResetAgentKey,
} from '../src/db/agent-admin.ts';

const SECRET = 'agent-api-test-secret';
const PUBLIC = 'https://mcp.metro.box';
const LOCAL = (): string => `http://127.0.0.1:${PORT()}`;

const fakeKey = (agent: string): string => `mk_fake_${agent}`;

const OWNED: Record<string, AgentSummary[]> = {
  'ada@lovelace.dev': [
    { id: 'agent000001', name: 'ada-bot', owned: true, key: fakeKey('ada-bot') },
  ],
  'bob@builder.dev': [
    { id: 'agent000002', name: 'bob-bot', owned: true, key: fakeKey('bob-bot') },
  ],
  'ada@same.dev': [{ id: 'agent000007', name: 'tony', owned: true, key: fakeKey('ada-tony') }],
  'bob@same.dev': [{ id: 'agent000008', name: 'tony', owned: true, key: fakeKey('bob-tony') }],
};

let leakGrantedKeys = false;
let liveAgents = new Map<string, { connected: boolean; lastSeenAt: number }>();
let heldConnectors = new Map<string, string[]>();

const ACCOUNTS_BY_AGENT_ID: Record<number, [string, unknown]> = {
  ["agent000001"]: ['telegram-bot', { id: 'ada-tg', owner: 'ada', agentId: 'agent000001' }],
  ["agent000002"]: ['discord-bot', { id: 'bob-dc', owner: 'bob', agentId: 'agent000002' }],
  ["agent000007"]: ['telegram-bot', { id: 'ada-tony-tg', owner: 'ada', agentId: 'agent000007' }],
  ["agent000008"]: ['telegram-bot', { id: 'bob-tony-tg', owner: 'bob', agentId: 'agent000008' }],
};

interface Row {
  id: string;
  name: string;
  ownerId: string | null;
}

const USER_IDS: Record<string, string> = {
  'ada@lovelace.dev': 'user0000011',
  'bob@builder.dev': 'user0000022',
};

const userIdFor = (email: string): string | null => USER_IDS[email] ?? null;

const SEED: Row[] = [
  { id: 'agent000001', name: 'ada-bot', ownerId: 'user0000011' },
  { id: 'agent000002', name: 'bob-bot', ownerId: 'user0000022' },
  { id: 'agent000005', name: 'legacy', ownerId: null },
];

let server: Server;
let base: string;
let scopes: Set<string>[] = [];
let created: { email: string; name: string }[] = [];
let rows: Row[] = [...SEED];
let deleteCalls: { email: string; id: number }[] = [];
let resetCalls: { email: string; id: number }[] = [];
let liveKeys: Record<string, string> = {};
let nextId = 10;
let resetSerial = 0;

function ownedRowOrThrow(email: string, id: number): Row {
  const ownerId = userIdFor(email);
  const row = rows.find((r) => r.id === id);
  const missing = new AgentAdminError('no such agent', 404);
  if (!row) throw missing;
  if (ownerId === null || row.ownerId === null || row.ownerId !== ownerId)
    throw missing;
  return row;
}

function removeAgent(email: string, id: number): DeletedAgent {
  deleteCalls.push({ email, id });
  const row = ownedRowOrThrow(email, id);
  if (row.name === 'busy-bot')
    throw new AgentAdminError(
      "agent 'busy-bot' still has 2 station account(s) attached, an operator must remove them first",
      409,
    );
  rows = rows.filter((r) => r.id !== id);
  return { id: row.id, name: row.name };
}

function resetKeyOf(email: string, id: number): ResetAgentKey {
  resetCalls.push({ email, id });
  const row = ownedRowOrThrow(email, id);
  resetSerial += 1;
  const key = `mk_rotated_${row.id}_${resetSerial}`;
  liveKeys[row.id] = key;
  return { id: row.id, name: row.name, key };
}

const PROJECT = 'prj00000001';

const deps: AgentApiDeps = {
  listAgents: (email, _project) =>
    Promise.resolve([
      ...(OWNED[email] ?? []),
      ...(leakGrantedKeys
        ? [{ id: 'agent000901', name: 'not-mine', owned: false, key: fakeKey('not-mine') }]
        : []),
    ]),
  createAgent: (email, _project, name) => {
    const clean = normalizeAgentName(name);
    created.push({ email, name: clean });
    nextId += 1;
    return Promise.resolve({ id: nextId, name: clean, key: `mk_key_for_${clean}` });
  },
  deleteAgent: (email, id) => {
    try {
      return Promise.resolve(removeAgent(email, id));
    } catch (e) {
      return Promise.reject(e as Error);
    }
  },
  resetKey: (email, id) => {
    try {
      return Promise.resolve(resetKeyOf(email, id));
    } catch (e) {
      return Promise.reject(e as Error);
    }
  },
  gatherAccounts: (allowed) => {
    scopes.push(allowed);
    const out: Record<string, unknown[]> = { 'telegram-bot': [], 'discord-bot': [] };
    for (const id of allowed) {
      const hit = ACCOUNTS_BY_AGENT_ID[id];
      if (hit) (out[hit[0]] as unknown[]).push(hit[1]);
    }
    return Promise.resolve({ accounts: out, unavailable: [] });
  },
  capabilities: () => ({ 'telegram-bot': ['send'], 'discord-bot': ['send', 'read'] }),
  liveness: () => liveAgents,
  connectorIds: () => Promise.resolve(heldConnectors),
  prepareAccount: () =>
    Promise.reject(new AgentAdminError('attaching is not exercised here', 400)),
  attachAccount: () =>
    Promise.reject(new AgentAdminError('attaching is not exercised here', 400)),
  detachAccount: () =>
    Promise.reject(new AgentAdminError('detaching is not exercised here', 400)),
  syncStations: () => Promise.resolve(),
};

const session = (email: string, secret = SECRET): string =>
  signSession({ subject: email, agentIds: [] }, secret);

const get = (token?: string): Promise<Response> =>
  fetch(`${base}/api/agents?project=${PROJECT}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

const getFull = (token?: string): Promise<Response> =>
  fetch(`${base}/api/agents?accounts=1&project=${PROJECT}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

const post = (token: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/agents?project=${PROJECT}`, {
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
  process.env.METRO_WEBHOOK_PORT = String(10000 + Math.floor(Math.random() * 20000));
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  server = await startWebhookServer(makeEmit(), { agentApi: deps });
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
  resetCalls = [];
  liveKeys = {};
  leakGrantedKeys = false;
  liveAgents = new Map();
  heldConnectors = new Map();
});

describe('/api/agents authentication', () => {
  test('no token is 401', async () => {
    expect((await get()).status).toBe(401);
  });

  test('a session signed with another secret is 401', async () => {
    expect((await get(session('ada@lovelace.dev', 'other-secret'))).status).toBe(401);
  });

  test('an expired session is 401', async () => {
    const stale = signSession({ subject: 'ada@lovelace.dev', agentIds: [] }, SECRET, {
      ttlSec: -10,
    });
    expect((await get(stale)).status).toBe(401);
  });

  test('a ?token= query param authenticates too', async () => {
    const res = await fetch(
      `${base}/api/agents?project=${PROJECT}&token=${encodeURIComponent(session('ada@lovelace.dev'))}`,
    );
    expect(res.status).toBe(200);
  });

  test('OPTIONS preflight is 204 with CORS', async () => {
    const res = await fetch(`${base}/api/agents?project=${PROJECT}`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  test('DELETE on the collection is 405 — deletion is per-agent-id only', async () => {
    const res = await fetch(`${base}/api/agents?project=${PROJECT}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${session('ada@lovelace.dev')}` },
    });
    expect(res.status).toBe(405);
    expect(deleteCalls).toEqual([]);
  });
});

interface WireAgent {
  id: string;
  name: string;
  owned: boolean;
  key: string | null;
  endpoint: string | null;
  command: string | null;
  connector_ids: string[];
}

interface ListBody {
  agents: WireAgent[];
  accounts: Record<string, unknown[]>;
}

const listAgents = async (email: string): Promise<WireAgent[]> =>
  ((await (await get(session(email))).json()) as ListBody).agents;

describe('GET /api/agents ownership', () => {
  test('returns only the caller own agents and their accounts', async () => {
    const res = await getFull(session('ada@lovelace.dev'));
    const body = (await res.json()) as ListBody;
    expect(body.agents.map((a) => a.name)).toEqual(['ada-bot']);
    expect(body.accounts['telegram-bot']).toEqual([{ id: 'ada-tg', owner: 'ada', agentId: 'agent000001' }]);
    expect(body.accounts['discord-bot']).toEqual([]);
  });

  test('another signed-in user never sees the first user agent', async () => {
    const body = (await (await getFull(session('bob@builder.dev'))).json()) as ListBody;
    expect(body.agents.map((a) => a.name)).toEqual(['bob-bot']);
    expect(body.accounts['telegram-bot']).toEqual([]);
    expect(body.accounts['discord-bot']).toEqual([{ id: 'bob-dc', owner: 'bob', agentId: 'agent000002' }]);
  });

  test('the accounts scope set is exactly the visible agent IDS, never names', async () => {
    await getFull(session('ada@lovelace.dev'));
    expect(scopes.at(-1)).toEqual(new Set(['agent000001']));
  });

  test('every returned account names the agent id it belongs to', async () => {
    const body = (await (await getFull(session('ada@lovelace.dev'))).json()) as ListBody;
    const rowsOut = Object.values(body.accounts).flat();
    expect(rowsOut.length).toBeGreaterThan(0);
    expect(rowsOut.map((a) => (a as { agentId?: unknown }).agentId)).toEqual(['agent000001']);
  });

  test('two owners whose agents share a name each see only their own accounts', async () => {
    const ada = (await (await getFull(session('ada@same.dev'))).json()) as ListBody;
    const adaScope = scopes.at(-1);
    const bob = (await (await getFull(session('bob@same.dev'))).json()) as ListBody;
    const bobScope = scopes.at(-1);

    expect(ada.agents.map((a) => a.name)).toEqual(['tony']);
    expect(bob.agents.map((a) => a.name)).toEqual(['tony']);
    expect(adaScope).toEqual(new Set(['agent000007']));
    expect(bobScope).toEqual(new Set(['agent000008']));
    expect(ada.accounts['telegram-bot']).toEqual([
      { id: 'ada-tony-tg', owner: 'ada', agentId: 'agent000007' },
    ]);
    expect(bob.accounts['telegram-bot']).toEqual([
      { id: 'bob-tony-tg', owner: 'bob', agentId: 'agent000008' },
    ]);
  });

  test('a brand-new signed-in user sees no agents and no accounts', async () => {
    const body = (await (await getFull(session('nobody@example.com'))).json()) as ListBody;
    expect(body.agents).toEqual([]);
    expect(scopes.at(-1)).toEqual(new Set());
    expect(body.accounts['telegram-bot']).toEqual([]);
  });

  test('the session email is compared case-insensitively', async () => {
    const body = (await (await getFull(session('ADA@Lovelace.dev'))).json()) as ListBody;
    expect(body.agents.map((a) => a.name)).toEqual(['ada-bot']);
  });

  test('responses are marked no-store', async () => {
    const res = await getFull(session('ada@lovelace.dev'));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /api/agents is light unless accounts are asked for', () => {
  test('the default payload carries agents but no accounts, and never gathers them', async () => {
    const before = scopes.length;
    const res = await get(session('ada@lovelace.dev'));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.agents).toBeDefined();
    expect(body.capabilities).toBeDefined();
    expect(body.attachable).toBeDefined();
    expect(body.accounts).toBeUndefined();
    expect(body.unavailable).toBeUndefined();
    expect(scopes.length).toBe(before);
  });

  test('?accounts=1 adds them and does gather', async () => {
    const before = scopes.length;
    const res = await getFull(session('ada@lovelace.dev'));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accounts).toBeDefined();
    expect(body.unavailable).toEqual([]);
    expect(scopes.length).toBe(before + 1);
  });

  test('any other value of accounts stays light — only "1" opts in', async () => {
    const before = scopes.length;
    for (const q of ['accounts=0', 'accounts=true', 'accounts=', 'accounts']) {
      const res = await fetch(`${base}/api/agents?${q}`, {
        headers: { authorization: `Bearer ${session('ada@lovelace.dev')}` },
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.accounts).toBeUndefined();
    }
    expect(scopes.length).toBe(before);
  });
});

describe('GET /api/agents key exposure', () => {
  test('an owned agent carries its key, tokenised endpoint and paste-ready command', async () => {
    const [agent] = await listAgents('ada@lovelace.dev');
    expect(agent).toEqual({
      id: 'agent000001',
      name: 'ada-bot',
      owned: true,
      connected: false,
      last_seen: null,
      connector_ids: [],
      key: 'mk_fake_ada-bot',
      endpoint: `${LOCAL()}/mcp?token=mk_fake_ada-bot`,
      command: `claude mcp add --transport http metro "${LOCAL()}/mcp?token=mk_fake_ada-bot"`,
    });
  });

  test('a live session surfaces as connected with a last_seen stamp', async () => {
    liveAgents = new Map([
      ['agent000001', { connected: true, lastSeenAt: Date.UTC(2026, 5, 21) }],
    ]);
    const [agent] = await listAgents('ada@lovelace.dev');
    expect(agent?.connected).toBe(true);
    expect(agent?.last_seen).toBe('2026-06-21T00:00:00.000Z');
  });

  test('an agent with a session but no stream reads as not connected', async () => {
    liveAgents = new Map([
      ['agent000001', { connected: false, lastSeenAt: Date.UTC(2026, 5, 21) }],
    ]);
    const [agent] = await listAgents('ada@lovelace.dev');
    expect(agent?.connected).toBe(false);
    expect(agent?.last_seen).toBe('2026-06-21T00:00:00.000Z');
  });

  test('liveness for an agent you do not own is never served', async () => {
    leakGrantedKeys = true;
    liveAgents = new Map([
      ['agent000003', { connected: true, lastSeenAt: Date.UTC(2026, 5, 21) }],
    ]);
    const agent = (await listAgents('nobody@example.com')).at(-1);
    expect(agent?.owned).toBe(false);
    expect([agent?.connected, agent?.last_seen]).toEqual([false, null]);
  });

  test('an unheld agent is handed the same local command', async () => {
    const [agent] = await listAgents('ada@lovelace.dev');
    expect(agent?.endpoint).toBe(
      `http://127.0.0.1:${PORT()}/mcp?token=mk_fake_ada-bot`,
    );
    expect(agent?.command).not.toContain(PUBLIC);
  });

  test('the listed command matches what POST hands back for the same key', async () => {
    const [agent] = await listAgents('ada@lovelace.dev');
    expect(agent?.command).toBe(mcpAddCommand('mk_fake_ada-bot'));
  });

  test('another signed-in user never receives the first user key', async () => {
    const body = await (await get(session('bob@builder.dev'))).text();
    expect(body).not.toContain('mk_fake_ada-bot');
  });

  test('a not-owned agent is listed with no key, endpoint or command', async () => {
    leakGrantedKeys = true;
    const agent = (await listAgents('nobody@example.com')).at(-1);
    expect(agent?.owned).toBe(false);
    expect([agent?.key, agent?.endpoint, agent?.command]).toEqual([null, null, null]);
  });

  test('a key value that reaches the api layer for a not-owned agent is still not served', async () => {
    leakGrantedKeys = true;
    const body = await (await get(session('ada@lovelace.dev'))).text();
    expect(body).toContain('not-mine');
    expect(body).not.toContain('mk_fake_not-mine');
  });

  test('an owned agent that has no key yet is served nulls, not a stale value', async () => {
    OWNED['keyless@example.com'] = [
      { id: 'agent000042', name: 'keyless', owned: true, key: null },
    ];
    const [agent] = await listAgents('keyless@example.com');
    expect(agent).toEqual({
      id: 'agent000042',
      name: 'keyless',
      owned: true,
      connected: false,
      last_seen: null,
      connector_ids: [],
      key: null,
      endpoint: null,
      command: null,
    });
    delete OWNED['keyless@example.com'];
  });
});

interface CreateBody {
  id: string;
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
    expect(body.name).toBe('Fresh-Agent');
    expect(body.key).toBe('mk_key_for_Fresh-Agent');
    expect(created).toEqual([{ email: 'ada@lovelace.dev', name: 'Fresh-Agent' }]);
  });

  test('the name is stored with the casing the person typed, never lowercased', async () => {
    const body = (await (
      await post(session('ada@lovelace.dev'), { name: '  Lisa  ' })
    ).json()) as CreateBody;
    expect(body.name).toBe('Lisa');
    expect(body.command).toContain(' metro "');
    expect(body.command).not.toContain('lisa');
  });

  test('returns the exact endpoint and claude mcp add command to paste', async () => {
    const body = (await (
      await post(session('ada@lovelace.dev'), { name: 'pasteme' })
    ).json()) as CreateBody;
    expect(body.endpoint).toBe(`${LOCAL()}/mcp?token=mk_key_for_pasteme`);
    expect(body.command).toBe(
      `claude mcp add --transport http metro "${LOCAL()}/mcp?token=mk_key_for_pasteme"`,
    );
  });

  test('the agent is always created for the session email, never a body-supplied one', async () => {
    await post(session('bob@builder.dev'), {
      name: 'sneaky',
      email: 'ada@lovelace.dev',
      ownerEmail: 'ada@lovelace.dev',
      ownerId: 'user0000011',
      owner_id: 11,
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

  test('the same name twice is created twice: the name is a label, not a key', async () => {
    const first = await post(session('ada@lovelace.dev'), { name: 'Lisa' });
    const second = await post(session('ada@lovelace.dev'), { name: 'Lisa' });
    expect([first.status, second.status]).toEqual([201, 201]);
    const a = (await first.json()) as CreateBody;
    const b = (await second.json()) as CreateBody;
    expect(a.id).not.toBe(b.id);
    expect(created).toEqual([
      { email: 'ada@lovelace.dev', name: 'Lisa' },
      { email: 'ada@lovelace.dev', name: 'Lisa' },
    ]);
  });

  test('a non-JSON body is 400', async () => {
    const res = await fetch(`${base}/api/agents?project=${PROJECT}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session('ada@lovelace.dev')}` },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  test('creating without a session is 401 and creates nothing', async () => {
    const res = await fetch(`${base}/api/agents?project=${PROJECT}`, {
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
    const res = await del(session('ada@lovelace.dev'), 'agent000001');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'agent000001', name: 'ada-bot', deleted: true });
    expect(rows.map((r) => r.id)).toEqual(['agent000002', 'agent000005']);
  });

  test('deleting someone else agent id is refused and leaves it intact', async () => {
    const res = await del(session('ada@lovelace.dev'), 'agent000002');
    expect(res.status).toBe(404);
    expect(rows.map((r) => r.id)).toEqual(['agent000001', 'agent000002', 'agent000005']);
    expect(deleteCalls).toEqual([
      { email: 'ada@lovelace.dev', id: 'agent000002' },
    ]);
  });

  test('an operator row the session cannot see is a plain 404', async () => {
    const res = await del(session('ada@lovelace.dev'), 'agent000005');
    expect(res.status).toBe(404);
    expect(rows.map((r) => r.id)).toEqual(['agent000001', 'agent000002', 'agent000005']);
  });

  test('the owner is always the session email, never anything from the request', async () => {
    await del(session('ADA@Lovelace.dev'), 'agent000001');
    expect(deleteCalls).toEqual([
      { email: 'ada@lovelace.dev', id: 'agent000001' },
    ]);
  });

  test('deleting without a session is 401 and deletes nothing', async () => {
    expect((await del(undefined, 'agent000001')).status).toBe(401);
    expect(deleteCalls).toEqual([]);
    expect(rows.map((r) => r.id)).toEqual(['agent000001', 'agent000002', 'agent000005']);
  });

  test('a session signed with another secret deletes nothing', async () => {
    const res = await del(session('ada@lovelace.dev', 'other-secret'), 'agent000001');
    expect(res.status).toBe(401);
    expect(rows.map((r) => r.id)).toEqual(['agent000001', 'agent000002', 'agent000005']);
  });

  test('a non-numeric or malformed id never reaches the database', async () => {
    for (const bad of ['abc', '0', '-1', '1.5', '1%20OR%201', 'ada-bot']) {
      expect((await del(session('ada@lovelace.dev'), bad)).status).toBe(404);
    }
    expect(deleteCalls).toEqual([]);
  });

  test('an unknown id is 404', async () => {
    expect((await del(session('ada@lovelace.dev'), 'agent009999')).status).toBe(404);
  });

  test('GET and POST on a single agent are 405', async () => {
    const token = session('ada@lovelace.dev');
    const headers = { authorization: `Bearer ${token}` };
    expect((await fetch(`${base}/api/agents/agent000001`, { headers })).status).toBe(405);
    expect(
      (await fetch(`${base}/api/agents/agent000001`, { method: 'POST', headers })).status,
    ).toBe(405);
    expect(rows.map((r) => r.id)).toEqual(['agent000001', 'agent000002', 'agent000005']);
  });

  test('OPTIONS preflight on a single agent advertises DELETE', async () => {
    const res = await fetch(`${base}/api/agents/agent000001`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
  });

  test('a second agent of the same owner survives the delete', async () => {
    rows = [
      ...SEED,
      { id: 'agent000006', name: 'ada-second', ownerId: 'user0000011' },
    ];
    expect((await del(session('ada@lovelace.dev'), 'agent000001')).status).toBe(200);
    expect(rows.map((r) => r.id)).toEqual(['agent000002', 'agent000005', 'agent000006']);
  });

  test('a 409 from the admin layer is forwarded with its message intact', async () => {
    rows = [...SEED, { id: 'agent000006', name: 'busy-bot', ownerId: 'user0000011' }];
    const res = await del(session('ada@lovelace.dev'), 'agent000006');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(
      'station account(s) attached',
    );
    expect(rows.map((r) => r.id)).toEqual(['agent000001', 'agent000002', 'agent000005', 'agent000006']);
  });
});

interface ResetBody {
  id: string;
  name: string;
  key: string;
  endpoint: string;
  command: string;
  reset: boolean;
  error?: string;
}

const resetKey = (token: string | undefined, path: string): Promise<Response> =>
  fetch(`${base}/api/agents/${path}/key`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe('POST /api/agents/:id/key', () => {
  test('an owner resets their own agent key and gets the new one back', async () => {
    const res = await resetKey(session('ada@lovelace.dev'), 'agent000001');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResetBody;
    expect(body.id).toBe('agent000001');
    expect(body.name).toBe('ada-bot');
    expect(body.reset).toBe(true);
    expect(body.key).toBe(liveKeys['agent000001']);
    expect(body.endpoint).toBe(`${LOCAL()}/mcp?token=${body.key}`);
    expect(body.command).toBe(mcpAddCommand(body.key));
  });

  test('the new key is never the old one', async () => {
    const first = (await (
      await resetKey(session('ada@lovelace.dev'), 'agent000001')
    ).json()) as ResetBody;
    const second = (await (
      await resetKey(session('ada@lovelace.dev'), 'agent000001')
    ).json()) as ResetBody;
    expect(second.key).not.toBe(first.key);
    expect(second.key).not.toBe('mk_fake_ada-bot');
  });

  test('a non-owner cannot reset another agent key', async () => {
    const res = await resetKey(session('ada@lovelace.dev'), 'agent000002');
    expect(res.status).toBe(404);
    expect(liveKeys).toEqual({});
    expect(resetCalls).toEqual([
      { email: 'ada@lovelace.dev', id: 'agent000002' },
    ]);
  });

  test('the refusal for someone else agent leaks no key material', async () => {
    const body = await (await resetKey(session('bob@builder.dev'), 'agent000001')).text();
    expect(body).not.toContain('mk_');
    expect(body).toBe(JSON.stringify({ error: 'no such agent' }));
  });

  test('an operator row the session cannot see is a plain 404', async () => {
    expect((await resetKey(session('ada@lovelace.dev'), 'agent000005')).status).toBe(404);
    expect(liveKeys).toEqual({});
  });

  test('resetting without a session is 401 and rotates nothing', async () => {
    expect((await resetKey(undefined, 'agent000001')).status).toBe(401);
    expect(resetCalls).toEqual([]);
    expect(liveKeys).toEqual({});
  });

  test('a session signed with another secret rotates nothing', async () => {
    const res = await resetKey(session('ada@lovelace.dev', 'other-secret'), 'agent000001');
    expect(res.status).toBe(401);
    expect(resetCalls).toEqual([]);
  });

  test('an agent key is not a session and cannot reach the reset route', async () => {
    const res = await resetKey('mk_fake_ada-bot', 'agent000001');
    expect(res.status).toBe(401);
    expect(resetCalls).toEqual([]);
  });

  test('the owner is always the session email, never anything from the request', async () => {
    await resetKey(session('ADA@Lovelace.dev'), 'agent000001');
    expect(resetCalls).toEqual([
      { email: 'ada@lovelace.dev', id: 'agent000001' },
    ]);
  });

  test('GET and DELETE on the key sub-resource are 405', async () => {
    const headers = { authorization: `Bearer ${session('ada@lovelace.dev')}` };
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/api/agents/agent000001/key`, { method, headers });
      expect(res.status).toBe(405);
    }
    expect(resetCalls).toEqual([]);
  });

  test('a malformed id never reaches the database', async () => {
    for (const bad of ['abc', '0', '-1', '1.5', 'ada-bot'])
      expect((await resetKey(session('ada@lovelace.dev'), bad)).status).toBe(404);
    expect(resetCalls).toEqual([]);
  });

  test('a deeper path under key is a 404, not a reset', async () => {
    const res = await fetch(`${base}/api/agents/agent000001/key/rotate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session('ada@lovelace.dev')}` },
    });
    expect(res.status).toBe(404);
    expect(resetCalls).toEqual([]);
  });

  test('an unknown id is 404', async () => {
    expect((await resetKey(session('ada@lovelace.dev'), 'agent009999')).status).toBe(404);
  });

  test('OPTIONS preflight on the key sub-resource advertises POST', async () => {
    const res = await fetch(`${base}/api/agents/agent000001/key`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  test('the reset response is marked no-store', async () => {
    const res = await resetKey(session('ada@lovelace.dev'), 'agent000001');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('mcpAddCommand', () => {
  test('the loopback url follows the port this daemon listens on', () => {
    const before = process.env.METRO_WEBHOOK_PORT;
    process.env.METRO_WEBHOOK_PORT = '8421';
    expect(mcpAddCommand('mk_x')).toContain('http://127.0.0.1:8421/mcp?token=mk_x');
    if (before === undefined) delete process.env.METRO_WEBHOOK_PORT;
    else process.env.METRO_WEBHOOK_PORT = before;
  });

  test('matches the browserbase convention: no --scope, full --transport http', () => {
    expect(mcpAddCommand('mk_x')).toBe(
      `claude mcp add --transport http metro "http://127.0.0.1:${PORT()}/mcp?token=mk_x"`,
    );
  });

  test('the server name is the constant metro, never the agent name', () => {
    const parts = mcpAddCommand('mk_x').split(' ');
    expect(parts.slice(0, 5)).toEqual([
      'claude',
      'mcp',
      'add',
      '--transport',
      'http',
    ]);
    expect(parts[5]).toBe('metro');
    expect(parts).toHaveLength(7);
  });

  test('only the token varies from one agent to the next', () => {
    expect(mcpAddCommand('mk_a')).toBe(
      mcpAddCommand('mk_b').replace('mk_b', 'mk_a'),
    );
  });

  test('no --scope flag is emitted at all', () => {
    expect(mcpAddCommand('mk_x')).not.toContain('--scope');
  });
});

describe('GET /api/agents carries what each agent holds', () => {
  test('connector ids ride on the agent, empty when it holds nothing', async () => {
    heldConnectors = new Map([['agent000001', ['conn0000001', 'conn0000002']]]);
    const [agent] = await listAgents('ada@lovelace.dev');
    expect(agent?.connector_ids).toEqual(['conn0000001', 'conn0000002']);
    const [other] = await listAgents('bob@builder.dev');
    expect(other?.connector_ids).toEqual([]);
  });
});
