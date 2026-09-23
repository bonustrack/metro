import { afterEach, beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { bootDaemon, type Daemon } from './http-harness.ts';
import { type AgentApiDeps } from '../src/agents/api.ts';
import { AgentAdminError } from '../src/agents/admin.ts';
import { auth, bearer, forged, type Who } from './identity-helper.ts';

const OWNER = 'ada@lovelace.dev';
const AGENT = { id: 'agent000001', name: 'ada-bot' };
const ACCOUNT = { id: 'ada-tg', agentId: 'agent000001' };

let daemon: Daemon;
let base: string;
let scopes: Set<string>[] = [];
let connectorMap = new Map<string, string[]>();

const deps: AgentApiDeps = {
  listAgents: () => Promise.resolve([AGENT]),
  gatherAccounts: (allowed) => {
    scopes.push(allowed);
    return Promise.resolve({ accounts: { 'telegram-bot': allowed.has(AGENT.id) ? [ACCOUNT] : [], 'discord-bot': [] }, unavailable: [] });
  },
  capabilities: () => ({ 'telegram-bot': ['send'], 'discord-bot': ['send', 'read'] }),
  connectorIds: () => Promise.resolve(connectorMap),
  attachSessions: {
    start: () => Promise.reject(new AgentAdminError('not exercised here', 400)),
    view: () => {
      throw new AgentAdminError('not exercised here', 400);
    },
    submit: () => Promise.reject(new AgentAdminError('not exercised here', 400)),
    cancel: () => Promise.reject(new AgentAdminError('not exercised here', 400)),
  },
  prepareAccount: () => Promise.reject(new AgentAdminError('not exercised here', 400)),
  attachAccount: () => Promise.reject(new AgentAdminError('not exercised here', 400)),
  detachAccount: () => Promise.reject(new AgentAdminError('not exercised here', 400)),
  setAllowlist: () => Promise.reject(new AgentAdminError('not exercised here', 400)),
  setAccountEnabled: () => Promise.reject(new AgentAdminError('not exercised here', 400)),
  recentSenders: () => [],
  resolveSender: () => Promise.reject(new AgentAdminError('not exercised here', 400)),
  accountCall: () => Promise.reject(new AgentAdminError('not exercised here', 400)),
  syncStations: () => Promise.resolve(),
  reloadAgents: () => Promise.resolve(),
};

const get = async (query = '', token?: Who): Promise<Response> =>
  fetch(`${base}/api/agents${query}`, {
    headers: token === undefined ? {} : { authorization: await auth(token) },
  });

beforeAll(async () => {
  daemon = await bootDaemon({ agentApi: deps });
  ({ base } = daemon);
});

afterAll(async () => {
  await daemon.close();
});

afterEach(() => {
  scopes = [];
  connectorMap = new Map();
});

describe('/api/agents authentication', () => {
  test('no token is 401', async () => {
    expect((await get()).status).toBe(401);
  });

  test('a token nobody issued is 401', async () => {
    expect((await fetch(`${base}/api/agents`, { headers: { authorization: await forged(OWNER) } })).status).toBe(401);
  });

  test('a token with no organization is 401', async () => {
    expect((await fetch(`${base}/api/agents`, { headers: { authorization: await bearer({ org_id: undefined }) } })).status).toBe(401);
  });

  test('a ?token= query param never carries a browser identity', async () => {
    const token = encodeURIComponent(await auth(OWNER));
    expect((await fetch(`${base}/api/agents?token=${token}`)).status).toBe(401);
  });

  test('OPTIONS preflight is 204, other methods 405, and an agent path alone is 404', async () => {
    expect((await fetch(`${base}/api/agents`, { method: 'OPTIONS' })).status).toBe(204);
    const headers = { authorization: await auth(OWNER) };
    expect((await fetch(`${base}/api/agents`, { method: 'POST', headers })).status).toBe(405);
    expect((await fetch(`${base}/api/agents`, { method: 'DELETE', headers })).status).toBe(405);
    expect((await fetch(`${base}/api/agents/agent000001`, { method: 'DELETE', headers })).status).toBe(404);
  });
});

describe('GET /api/agents', () => {
  test('lists the one agent with its connectors, never its key', async () => {
    connectorMap = new Map([['agent000001', ['conn0000001', 'conn0000002']]]);
    const res = await get('', OWNER);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.agents).toEqual([{ id: 'agent000001', name: 'ada-bot', connector_ids: ['conn0000001', 'conn0000002'] }]);
    expect(body.capabilities).toBeDefined();
    expect(body.attachable).toBeDefined();
    expect(body.accounts).toBeUndefined();
    expect(scopes).toEqual([]);
  });

  test('?accounts=1 gathers the accounts of that agent id, and only "1" opts in', async () => {
    const body = (await (await get('?accounts=1', OWNER)).json()) as { accounts: Record<string, unknown[]>; unavailable: string[] };
    expect(body.accounts['telegram-bot']).toEqual([ACCOUNT]);
    expect(body.unavailable).toEqual([]);
    expect(scopes).toEqual([new Set(['agent000001'])]);
    for (const q of ['?accounts=0', '?accounts=true', '?accounts'])
      expect(((await (await get(q, OWNER)).json()) as Record<string, unknown>).accounts).toBeUndefined();
    expect(scopes).toHaveLength(1);
  });

  test('an old page that still sends ?project= is answered the same', async () => {
    const body = (await (await get('?accounts=1&project=localdaemon', OWNER)).json()) as { agents: unknown[] };
    expect(body.agents).toHaveLength(1);
  });
});
