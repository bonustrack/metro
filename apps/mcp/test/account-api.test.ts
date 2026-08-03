import { afterEach, beforeAll, afterAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { signSession } from '../src/daemon/session.ts';
import type { AgentApiDeps } from '../src/daemon/agent-api.ts';
import { AgentAdminError, type AgentSummary } from '../src/db/agent-admin.ts';
import type { StationName } from '../src/db/schema.ts';
import {
  StationAttachError,
  type AttachInput,
  type PreparedAccount,
} from '../src/stations/attach.ts';

const SECRET = 'account-api-test-secret';
const FAKE_TOKEN = 'fake-bot-token-not-real';
const FAKE_KEY = '0xfeed0000000000000000000000000000000000000000000000000000000fake1';

interface Row {
  agentId: number;
  station: StationName;
  accountId: string;
  config: Record<string, unknown>;
}

const AGENTS: Record<string, AgentSummary[]> = {
  'ada@lovelace.dev': [{ id: 1, name: 'ada-bot', owned: true, keys: [] }],
  'bob@builder.dev': [{ id: 2, name: 'bob-bot', owned: true, keys: [] }],
};

const OWNER_OF: Record<number, string | null> = {
  1: 'ada@lovelace.dev',
  2: 'bob@builder.dev',
  5: null,
};

let server: Server;
let base: string;
let rows: Row[] = [];
let synced: string[] = [];
let prepared: AttachInput[] = [];
let nextAccount = 0;
let syncFails = false;

function ownedOrThrow(email: string, granted: string[], id: number): void {
  const owner = OWNER_OF[id];
  const missing = new AgentAdminError('no such agent', 404);
  if (owner === undefined) throw missing;
  if (owner === null) {
    if (!granted.includes('legacy')) throw missing;
    throw new AgentAdminError(
      'operator-provisioned agents cannot be changed here',
      403,
    );
  }
  if (owner !== email) throw missing;
}

function fakePrepare(input: AttachInput): Promise<PreparedAccount> {
  prepared.push(input);
  if (input.station === 'xmtp')
    return Promise.resolve({
      config: { privateKey: FAKE_KEY },
      identity: {},
      secret: { label: 'xmtp private key', value: FAKE_KEY, note: 'once only' },
    });
  if (typeof input.token !== 'string' || input.token === '')
    return Promise.reject(new StationAttachError('a bot token is required', 400));
  if (input.token === 'bad')
    return Promise.reject(new StationAttachError('that token was rejected', 400));
  return Promise.resolve({
    config: { token: input.token },
    identity: { username: 'fakebot' },
  });
}

const deps: AgentApiDeps = {
  listAgents: (email) => Promise.resolve(AGENTS[email] ?? []),
  createAgent: () => Promise.reject(new AgentAdminError('not used here', 400)),
  deleteAgent: () => Promise.reject(new AgentAdminError('not used here', 400)),
  gatherAccounts: () => Promise.resolve({}),
  capabilities: () => ({}),
  prepareAccount: fakePrepare,
  attachAccount: (email, granted, agentId, station, config) => {
    ownedOrThrow(email, granted, agentId);
    if (
      typeof config.token === 'string' &&
      rows.some((r) => r.station === station && r.config.token === config.token)
    )
      throw new AgentAdminError(
        'that bot token is already attached to a Metro account',
        409,
      );
    nextAccount += 1;
    const accountId = `a${agentId}-0000000${nextAccount}`;
    rows.push({ agentId, station, accountId, config });
    return Promise.resolve({ agentId, station, accountId });
  },
  detachAccount: (email, granted, agentId, station, accountId) => {
    ownedOrThrow(email, granted, agentId);
    const before = rows.length;
    rows = rows.filter(
      (r) =>
        !(
          r.agentId === agentId &&
          r.station === station &&
          r.accountId === accountId
        ),
    );
    if (rows.length === before)
      throw new AgentAdminError('no such account on this agent', 404);
    return Promise.resolve({ agentId, station, accountId });
  },
  syncStations: (station) => {
    if (syncFails) return Promise.reject(new Error('reload blew up'));
    synced.push(station);
    return Promise.resolve();
  },
};

const session = (email: string, secret = SECRET): string =>
  signSession({ email, agentIds: [] }, secret);

const start = (
  token: string | undefined,
  agentId: number | string,
  body: unknown,
): Promise<Response> =>
  fetch(`${base}/api/agents/${agentId}/accounts/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

const detach = (
  token: string | undefined,
  agentId: number | string,
  path: string,
): Promise<Response> =>
  fetch(`${base}/api/agents/${agentId}/accounts/${path}`, {
    method: 'DELETE',
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

interface AttachBody {
  status?: string;
  agentId?: number;
  station?: string;
  accountId?: string;
  identity?: Record<string, string>;
  activated?: boolean;
  secret?: { value?: string };
  error?: string;
}

beforeAll(async () => {
  process.env.METRO_SESSION_SECRET = SECRET;
  process.env.METRO_PUBLIC_URL = 'https://mcp.metro.box';
  delete process.env.GOOGLE_EMAIL_AGENTS;
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  process.env.METRO_WEBHOOK_PORT = String(
    20000 + Math.floor(Math.random() * 20000),
  );
  server = await startWebhookServer(makeEmit(), undefined, undefined, deps);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.METRO_SESSION_SECRET;
  delete process.env.METRO_PUBLIC_URL;
});

afterEach(() => {
  rows = [];
  synced = [];
  prepared = [];
  nextAccount = 0;
  syncFails = false;
  delete process.env.GOOGLE_EMAIL_AGENTS;
});

describe('POST /api/agents/:id/accounts/start authorisation', () => {
  test('no session attaches nothing', async () => {
    const res = await start(undefined, 1, {
      station: 'telegram',
      token: FAKE_TOKEN,
    });
    expect(res.status).toBe(401);
    expect(rows).toEqual([]);
    expect(prepared).toEqual([]);
  });

  test('a session signed with another secret attaches nothing', async () => {
    const res = await start(session('ada@lovelace.dev', 'other'), 1, {
      station: 'telegram',
      token: FAKE_TOKEN,
    });
    expect(res.status).toBe(401);
    expect(rows).toEqual([]);
  });

  test('attaching to somebody else agent is a flat 404', async () => {
    const res = await start(session('ada@lovelace.dev'), 2, {
      station: 'telegram',
      token: FAKE_TOKEN,
    });
    expect(res.status).toBe(404);
    expect(rows).toEqual([]);
  });

  test('a grant (owned:false) may not attach to an operator agent', async () => {
    process.env.GOOGLE_EMAIL_AGENTS = '{"ada@lovelace.dev":["legacy"]}';
    const res = await start(session('ada@lovelace.dev'), 5, {
      station: 'telegram',
      token: FAKE_TOKEN,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as AttachBody).error).toContain(
      'operator-provisioned',
    );
    expect(rows).toEqual([]);
  });

  test('an operator agent the session cannot see is a plain 404', async () => {
    const res = await start(session('ada@lovelace.dev'), 5, {
      station: 'telegram',
      token: FAKE_TOKEN,
    });
    expect(res.status).toBe(404);
    expect(rows).toEqual([]);
  });

  test('a malformed agent id never reaches the attach path', async () => {
    for (const bad of ['abc', '0', '-1', '1.5', 'ada-bot']) {
      expect((await start(session('ada@lovelace.dev'), bad, {})).status).toBe(404);
    }
    expect(prepared).toEqual([]);
  });
});

describe('POST /api/agents/:id/accounts/start', () => {
  test('attaches a telegram bot and reloads the station', async () => {
    const res = await start(session('ada@lovelace.dev'), 1, {
      station: 'telegram',
      token: FAKE_TOKEN,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as AttachBody;
    expect(body.status).toBe('done');
    expect(body.station).toBe('telegram');
    expect(body.agentId).toBe(1);
    expect(body.identity).toEqual({ username: 'fakebot' });
    expect(body.activated).toBe(true);
    expect(rows).toEqual([
      {
        agentId: 1,
        station: 'telegram',
        accountId: 'a1-00000001',
        config: { token: FAKE_TOKEN },
      },
    ]);
    expect(synced).toEqual(['telegram']);
  });

  test('the account id is generated by the server, never taken from the body', async () => {
    const res = await start(session('ada@lovelace.dev'), 1, {
      station: 'telegram',
      token: FAKE_TOKEN,
      accountId: 'chosen-by-me',
      agentId: 2,
    });
    const body = (await res.json()) as AttachBody;
    expect(body.accountId).toBe('a1-00000001');
    expect(body.agentId).toBe(1);
    expect(rows[0]?.agentId).toBe(1);
  });

  test('the stored bot token is never echoed back', async () => {
    const res = await start(session('ada@lovelace.dev'), 1, {
      station: 'telegram',
      token: FAKE_TOKEN,
    });
    expect(await res.text()).not.toContain(FAKE_TOKEN);
  });

  test('an xmtp attach generates a key and shows it exactly once', async () => {
    const res = await start(session('ada@lovelace.dev'), 1, { station: 'xmtp' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as AttachBody;
    expect(body.secret?.value).toBe(FAKE_KEY);
    expect(rows[0]?.config.privateKey).toBe(FAKE_KEY);
    expect(synced).toEqual(['xmtp']);
  });

  test('a token station carries no one-time secret', async () => {
    const res = await start(session('ada@lovelace.dev'), 1, {
      station: 'discord',
      token: FAKE_TOKEN,
    });
    expect((await res.json()) as AttachBody).not.toHaveProperty('secret');
  });

  test('an unknown or non-attachable station is 400 and writes nothing', async () => {
    for (const station of ['line', 'nope', 42, null]) {
      const res = await start(session('ada@lovelace.dev'), 1, { station });
      expect(res.status).toBe(400);
    }
    expect(rows).toEqual([]);
  });

  test('a credential the station rejects is 400 and writes nothing', async () => {
    const res = await start(session('ada@lovelace.dev'), 1, {
      station: 'discord',
      token: 'bad',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as AttachBody).error).toContain('rejected');
    expect(rows).toEqual([]);
    expect(synced).toEqual([]);
  });

  test('a missing token is 400 before anything is written', async () => {
    const res = await start(session('ada@lovelace.dev'), 1, {
      station: 'telegram',
    });
    expect(res.status).toBe(400);
    expect(rows).toEqual([]);
  });

  test('a duplicate bot token is 409', async () => {
    await start(session('ada@lovelace.dev'), 1, {
      station: 'telegram',
      token: FAKE_TOKEN,
    });
    const res = await start(session('ada@lovelace.dev'), 1, {
      station: 'telegram',
      token: FAKE_TOKEN,
    });
    expect(res.status).toBe(409);
    expect(rows.length).toBe(1);
  });

  test('a failed station reload still reports the account as attached', async () => {
    syncFails = true;
    const res = await start(session('ada@lovelace.dev'), 1, {
      station: 'telegram',
      token: FAKE_TOKEN,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as AttachBody).activated).toBe(false);
    expect(rows.length).toBe(1);
  });

  test('GET and DELETE on the start path are 405', async () => {
    const headers = { authorization: `Bearer ${session('ada@lovelace.dev')}` };
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/api/agents/1/accounts/start`, {
        method,
        headers,
      });
      expect(res.status).toBe(405);
    }
  });

  test('a non-JSON body is 400', async () => {
    const res = await fetch(`${base}/api/agents/1/accounts/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session('ada@lovelace.dev')}` },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/agents/:id/accounts/:station/:account', () => {
  const attachOne = async (email: string, agentId: number): Promise<string> => {
    const res = await start(session(email), agentId, {
      station: 'telegram',
      token: `${FAKE_TOKEN}-${agentId}`,
    });
    return ((await res.json()) as AttachBody).accountId ?? '';
  };

  test('the owner detaches their own account and the station reloads', async () => {
    const id = await attachOne('ada@lovelace.dev', 1);
    synced = [];
    const res = await detach(session('ada@lovelace.dev'), 1, `telegram/${id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      agentId: 1,
      station: 'telegram',
      accountId: id,
      detached: true,
      activated: true,
    });
    expect(rows).toEqual([]);
    expect(synced).toEqual(['telegram']);
  });

  test('another owner cannot detach it', async () => {
    const id = await attachOne('ada@lovelace.dev', 1);
    const res = await detach(session('bob@builder.dev'), 1, `telegram/${id}`);
    expect(res.status).toBe(404);
    expect(rows.length).toBe(1);
  });

  test('detaching without a session removes nothing', async () => {
    const id = await attachOne('ada@lovelace.dev', 1);
    expect((await detach(undefined, 1, `telegram/${id}`)).status).toBe(401);
    expect(rows.length).toBe(1);
  });

  test('an unknown account on an owned agent is 404', async () => {
    const res = await detach(session('ada@lovelace.dev'), 1, 'telegram/a1-ffff');
    expect(res.status).toBe(404);
  });

  test('an unknown station name never reaches the database', async () => {
    const res = await detach(session('ada@lovelace.dev'), 1, 'nope/a1-0000');
    expect(res.status).toBe(404);
    expect(((await res.json()) as AttachBody).error).toBe('no such agent');
  });

  test('a path-traversing account id is refused', async () => {
    for (const bad of ['telegram/..', 'telegram/a1%20b', 'telegram/A1-XX']) {
      expect((await detach(session('ada@lovelace.dev'), 1, bad)).status).toBe(404);
    }
  });

  test('POST on an account path is 405', async () => {
    const res = await fetch(`${base}/api/agents/1/accounts/telegram/a1-0000`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session('ada@lovelace.dev')}` },
    });
    expect(res.status).toBe(405);
  });
});

describe('GET /api/agents advertises what can be attached', () => {
  test('lists the attachable stations', async () => {
    const res = await fetch(`${base}/api/agents`, {
      headers: { authorization: `Bearer ${session('ada@lovelace.dev')}` },
    });
    const body = (await res.json()) as { attachable?: string[] };
    expect(body.attachable).toEqual(['discord', 'telegram', 'xmtp']);
  });
});
