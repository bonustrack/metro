import { afterEach, beforeAll, afterAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { signSession } from '../src/daemon/session.ts';
import type { AgentApiDeps } from '../src/daemon/agent-api.ts';
import {
  AgentAdminError,
  normalizeAgentName,
  type AgentSummary,
} from '../src/db/agent-admin.ts';

const SECRET = 'agent-api-test-secret';
const PUBLIC = 'https://mcp.metro.box';

const OWNED: Record<string, AgentSummary[]> = {
  'ada@lovelace.dev': [{ id: 1, name: 'ada-bot', owned: true, keys: ['default'] }],
  'bob@builder.dev': [{ id: 2, name: 'bob-bot', owned: true, keys: ['default'] }],
};

let server: Server;
let base: string;
let scopes: Set<string>[] = [];
let created: { email: string; name: string }[] = [];
let nextId = 10;

const deps: AgentApiDeps = {
  listAgents: (email, granted) =>
    Promise.resolve([
      ...(OWNED[email] ?? []),
      ...granted.map((name, i) => ({
        id: 900 + i,
        name,
        owned: false,
        keys: [] as string[],
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
  gatherAccounts: (allowed) => {
    scopes.push(allowed);
    const out: Record<string, unknown[]> = { telegram: [], discord: [] };
    if (allowed.has('ada-bot')) out.telegram = [{ id: 'ada-tg', owner: 'ada' }];
    if (allowed.has('bob-bot')) out.discord = [{ id: 'bob-dc', owner: 'bob' }];
    return Promise.resolve(out);
  },
  capabilities: () => ({ telegram: ['send'], discord: ['send', 'read'] }),
};

const session = (email: string, secret = SECRET): string =>
  signSession({ email, agents: [] }, secret);

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
    const stale = signSession({ email: 'ada@lovelace.dev', agents: [] }, SECRET, {
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

  test('DELETE is 405', async () => {
    const res = await fetch(`${base}/api/agents`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${session('ada@lovelace.dev')}` },
    });
    expect(res.status).toBe(405);
  });
});

interface ListBody {
  email: string;
  endpoint: string;
  agents: AgentSummary[];
  accounts: Record<string, unknown[]>;
}

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

  test('the accounts scope set is exactly the visible agent names', async () => {
    await get(session('ada@lovelace.dev'));
    expect(scopes.at(-1)).toEqual(new Set(['ada-bot']));
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
