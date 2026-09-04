import { auth, TEST_STRANGER, type Who } from './identity-helper.ts';
import { afterEach, beforeAll, afterAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import type { AgentApiDeps } from '../src/daemon/agent-api.ts';
import { AttachSessions } from '../src/daemon/attach-session.ts';
import { AgentAdminError, type AgentSummary } from '../src/db/agent-admin.ts';
import type { StationName } from '../src/db/schema.ts';
import {
  StationAttachError,
  type AttachInput,
  type PreparedAccount,
} from '../src/stations/attach.ts';

const FAKE_TOKEN = 'fake-bot-token-not-real';
const FAKE_KEY = '0xfeed0000000000000000000000000000000000000000000000000000000fake1';
const FAKE_HOOK_SECRET = 'b'.repeat(64);
const FAKE_HOOK_ID = '1493556940637339623';

interface Row {
  agentId: string;
  station: StationName;
  accountId: string;
  config: Record<string, unknown>;
}

const AGENTS: Record<string, AgentSummary[]> = {
  'ada@lovelace.dev': [{ id: 'agent000001', name: 'ada-bot', owned: true, key: null }],
  'bob@builder.dev': [{ id: 'agent000002', name: 'bob-bot', owned: true, key: null }],
};

const OWNER_OF: Record<string, string | null> = {
  agent000001: 'ada@lovelace.dev',
  agent000002: 'bob@builder.dev',
  agent000005: null,
};

let server: Server;
let base: string;
let rows: Row[] = [];
let synced: string[] = [];
let prepared: AttachInput[] = [];
let nextAccount = 0;
let syncFails = false;
let xmtpInboxFails = false;
let attachFails = false;
let discarded = 0;

function ownedOrThrow(email: string, id: string): void {
  const owner = OWNER_OF[id];
  const missing = new AgentAdminError('no such agent', 404);
  if (owner === undefined || owner === null) throw missing;
  if (owner !== email) throw missing;
}

function fakePrepare(input: AttachInput): Promise<PreparedAccount> {
  prepared.push(input);
  if (input.station === 'webhook')
    return Promise.resolve({
      config: { secret: FAKE_HOOK_SECRET, webhookId: FAKE_HOOK_ID },
      identity: {
        endpoint: `https://hooks.test/api/webhooks/${FAKE_HOOK_ID}/${FAKE_HOOK_SECRET}`,
      },
    });
  if (input.station === 'xmtp') {
    if (xmtpInboxFails)
      return Promise.reject(
        new StationAttachError('XMTP did not register an inbox for that key', 400),
      );
    return Promise.resolve({
      config: { privateKey: FAKE_KEY, dbPath: '~/.metro/xmtp-production-f00d.db3' },
      identity: { inboxId: 'inbox-f00d' },
      secret: { label: 'xmtp private key', value: FAKE_KEY, note: 'once only' },
      discard: () => {
        discarded += 1;
      },
    });
  }
  if (typeof input.token !== 'string' || input.token === '')
    return Promise.reject(new StationAttachError('a bot token is required', 400));
  if (input.token === 'bad')
    return Promise.reject(new StationAttachError('that token was rejected', 400));
  return Promise.resolve({
    config: { token: input.token },
    identity: { username: 'fakebot' },
  });
}

const attachSessions = new AttachSessions({
  authorize: (owner) => {
    try {
      ownedOrThrow(owner.subject, owner.agentId);
    } catch (err) {
      return Promise.reject(err as Error);
    }
    return Promise.resolve();
  },
  complete: (owner, station, config) => {
    nextAccount += 1;
    const accountId = `acct${String(nextAccount).padStart(7, '0')}`;
    try {
      ownedOrThrow(owner.subject, owner.agentId);
    } catch (err) {
      return Promise.reject(err as Error);
    }
    rows.push({ agentId: owner.agentId, station, accountId, config });
    return Promise.resolve({ accountId, activated: true });
  },
  start: (station, input, hooks) => {
    if (input.phone === 'reject')
      return Promise.reject(new AgentAdminError('that number was refused', 400));
    if (input.phone === 'handset-refuses')
      setTimeout(() => {
        hooks.fail('WhatsApp ended the pairing, start again');
      }, 0);
    return Promise.resolve({
      prompt: { step: 'code', prompt: 'enter the code' },
      driver: {
        submit: (values) => {
          if (values.code === '000000') {
            hooks.fail('that login code is not right');
            return Promise.resolve();
          }
          hooks.done({
            config: { session: `fake-session-for-${station}` },
            identity: { userId: String(values.code) },
          });
          return Promise.resolve();
        },
        cancel: () => Promise.resolve(),
      },
    });
  },
});

const PROJECT = 'prj00000001';

const deps: AgentApiDeps = {
  attachSessions,
  listAgents: (email, _project) => Promise.resolve(AGENTS[email] ?? []),
  createAgent: () => Promise.reject(new AgentAdminError('not used here', 400)),
  deleteAgent: () => Promise.reject(new AgentAdminError('not used here', 400)),
  gatherAccounts: () => Promise.resolve({}),
  capabilities: () => ({}),
  liveness: () => new Map(),
  connectorIds: () => Promise.resolve(new Map()),
  prepareAccount: fakePrepare,
  attachAccount: (email, agentId, station, config) => {
    ownedOrThrow(email, agentId);
    if (attachFails) throw new AgentAdminError('postgres said no', 500);
    if (
      typeof config.token === 'string' &&
      rows.some((r) => r.station === station && r.config.token === config.token)
    )
      throw new AgentAdminError(
        'that bot token is already attached to a Metro account',
        409,
      );
    nextAccount += 1;
    const accountId = `acct${String(nextAccount).padStart(7, '0')}`;
    rows.push({ agentId, station, accountId, config });
    return Promise.resolve({ agentId, station, accountId });
  },
  detachAccount: (email, agentId, station, accountId) => {
    ownedOrThrow(email, agentId);
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

const session = (email: string): string => email;

const start = async (
  token: Who | undefined,
  agentId: string,
  body: unknown,
): Promise<Response> =>
  fetch(`${base}/api/agents/${agentId}/accounts/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: await auth('POST', `/api/agents/${agentId}/accounts/start`, token) }),
    },
    body: JSON.stringify(body),
  });

const detach = async (
  token: Who | undefined,
  agentId: string,
  path: string,
): Promise<Response> =>
  fetch(`${base}/api/agents/${agentId}/accounts/${path}`, {
    method: 'DELETE',
    headers: token === undefined ? {} : { authorization: await auth('DELETE', `/api/agents/${agentId}/accounts/${path}`, token) },
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
  process.env.METRO_PUBLIC_URL = 'https://mcp.metro.box';
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  process.env.METRO_WEBHOOK_PORT = String(
    10000 + Math.floor(Math.random() * 20000),
  );
  server = await startWebhookServer(makeEmit(), { agentApi: deps });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.METRO_PUBLIC_URL;
});

afterEach(() => {
  rows = [];
  synced = [];
  prepared = [];
  nextAccount = 0;
  syncFails = false;
  xmtpInboxFails = false;
  attachFails = false;
  discarded = 0;
});

describe('POST /api/agents/:id/accounts/start authorisation', () => {
  test('no session attaches nothing', async () => {
    const res = await start(undefined, 'agent000001', {
      station: 'telegram-bot',
      token: FAKE_TOKEN,
    });
    expect(res.status).toBe(401);
    expect(rows).toEqual([]);
    expect(prepared).toEqual([]);
  });

  test('a session signed with another secret attaches nothing', async () => {
    const res = await start(TEST_STRANGER, 'agent000001', {
      station: 'telegram-bot',
      token: FAKE_TOKEN,
    });
    expect(res.status).toBe(401);
    expect(rows).toEqual([]);
  });

  test('attaching to somebody else agent is a flat 404', async () => {
    const res = await start(session('ada@lovelace.dev'), 'agent000002', {
      station: 'telegram-bot',
      token: FAKE_TOKEN,
    });
    expect(res.status).toBe(404);
    expect(rows).toEqual([]);
  });

  test('an operator-provisioned agent is never attachable, by anyone', async () => {
    const res = await start(session('ada@lovelace.dev'), 'agent000005', {
      station: 'telegram-bot',
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
  test('attaches a telegram-bot and reloads the station', async () => {
    const res = await start(session('ada@lovelace.dev'), 'agent000001', {
      station: 'telegram-bot',
      token: FAKE_TOKEN,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as AttachBody;
    expect(body.status).toBe('done');
    expect(body.station).toBe('telegram-bot');
    expect(body.agentId).toBe('agent000001');
    expect(body.identity).toEqual({ username: 'fakebot' });
    expect(body.activated).toBe(true);
    expect(rows).toEqual([
      {
        agentId: 'agent000001',
        station: 'telegram-bot',
        accountId: 'acct0000001',
        config: { token: FAKE_TOKEN },
      },
    ]);
    expect(synced).toEqual(['telegram-bot']);
  });

  test('the account id is generated by the server, never taken from the body', async () => {
    const res = await start(session('ada@lovelace.dev'), 'agent000001', {
      station: 'telegram-bot',
      token: FAKE_TOKEN,
      accountId: 'chosen-by-me',
      agentId: 'agent000002',
    });
    const body = (await res.json()) as AttachBody;
    expect(body.accountId).toBe('acct0000001');
    expect(body.agentId).toBe('agent000001');
    expect(rows[0]?.agentId).toBe('agent000001');
  });

  test('a webhook attach answers with a url naming its own webhook id', async () => {
    const res = await start(session('ada@lovelace.dev'), 'agent000001', {
      station: 'webhook',
      accountId: 'chosen-by-me',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as AttachBody;
    expect(body.accountId).toBe('acct0000001');
    expect(body.identity).toEqual({
      endpoint: `https://hooks.test/api/webhooks/${FAKE_HOOK_ID}/${FAKE_HOOK_SECRET}`,
    });
    expect(JSON.stringify(body.identity)).not.toContain('a1-');
    expect(rows).toEqual([
      {
        agentId: 'agent000001',
        station: 'webhook',
        accountId: 'acct0000001',
        config: { secret: FAKE_HOOK_SECRET, webhookId: FAKE_HOOK_ID },
      },
    ]);
    expect(synced).toEqual(['webhook']);
  });

  test('the stored bot token is never echoed back', async () => {
    const res = await start(session('ada@lovelace.dev'), 'agent000001', {
      station: 'telegram-bot',
      token: FAKE_TOKEN,
    });
    expect(await res.text()).not.toContain(FAKE_TOKEN);
  });

  test('an xmtp attach generates a key and shows it exactly once', async () => {
    const res = await start(session('ada@lovelace.dev'), 'agent000001', { station: 'xmtp' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as AttachBody;
    expect(body.secret?.value).toBe(FAKE_KEY);
    expect(rows[0]?.config.privateKey).toBe(FAKE_KEY);
    expect(synced).toEqual(['xmtp']);
  });

  test('a token station carries no one-time secret', async () => {
    const res = await start(session('ada@lovelace.dev'), 'agent000001', {
      station: 'discord-bot',
      token: FAKE_TOKEN,
    });
    expect((await res.json()) as AttachBody).not.toHaveProperty('secret');
  });

  test('an unknown or non-attachable station is 400 and writes nothing', async () => {
    for (const station of ['line', 'nope', 42, null]) {
      const res = await start(session('ada@lovelace.dev'), 'agent000001', { station });
      expect(res.status).toBe(400);
    }
    expect(rows).toEqual([]);
  });

  test('a credential the station rejects is 400 and writes nothing', async () => {
    const res = await start(session('ada@lovelace.dev'), 'agent000001', {
      station: 'discord-bot',
      token: 'bad',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as AttachBody).error).toContain('rejected');
    expect(rows).toEqual([]);
    expect(synced).toEqual([]);
  });

  test('a missing token is 400 before anything is written', async () => {
    const res = await start(session('ada@lovelace.dev'), 'agent000001', {
      station: 'telegram-bot',
    });
    expect(res.status).toBe(400);
    expect(rows).toEqual([]);
  });

  test('a duplicate bot token is 409', async () => {
    await start(session('ada@lovelace.dev'), 'agent000001', {
      station: 'telegram-bot',
      token: FAKE_TOKEN,
    });
    const res = await start(session('ada@lovelace.dev'), 'agent000001', {
      station: 'telegram-bot',
      token: FAKE_TOKEN,
    });
    expect(res.status).toBe(409);
    expect(rows.length).toBe(1);
  });

  test('a failed station reload still reports the account as attached', async () => {
    syncFails = true;
    const res = await start(session('ada@lovelace.dev'), 'agent000001', {
      station: 'telegram-bot',
      token: FAKE_TOKEN,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as AttachBody).activated).toBe(false);
    expect(rows.length).toBe(1);
  });

  test('GET and DELETE on the start path are 405', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/api/agents/agent000001/accounts/start`, {
        method,
        headers: { authorization: await auth(method, '/api/agents/agent000001/accounts/start', 'ada@lovelace.dev') },
      });
      expect(res.status).toBe(405);
    }
  });

  test('a non-JSON body is 400', async () => {
    const res = await fetch(`${base}/api/agents/agent000001/accounts/start`, {
      method: 'POST',
      headers: { authorization: await auth('POST', `${base}/api/agents/agent000001/accounts/start`, 'ada@lovelace.dev') },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('no accounts row exists unless the credential was demonstrated to work', () => {
  const seed = async (): Promise<Row[]> => {
    await start(session('ada@lovelace.dev'), 'agent000001', {
      station: 'telegram-bot',
      token: `${FAKE_TOKEN}-seed`,
    });
    synced = [];
    return structuredClone(rows);
  };

  const refusals: { name: string; body: unknown; status: number }[] = [
    {
      name: 'a Discord token the provider rejects',
      body: { station: 'discord-bot', token: 'bad' },
      status: 400,
    },
    {
      name: 'a Telegram token that was never given',
      body: { station: 'telegram-bot' },
      status: 400,
    },
    {
      name: 'a Telegram token the provider rejects',
      body: { station: 'telegram-bot', token: 'bad' },
      status: 400,
    },
    { name: 'a station Metro cannot attach', body: { station: 'line' }, status: 400 },
  ];

  for (const refusal of refusals) {
    test(`${refusal.name} leaves the table byte for byte as it was`, async () => {
      const before = await seed();
      const res = await start(session('ada@lovelace.dev'), 'agent000001', refusal.body);
      expect(res.status).toBe(refusal.status);
      expect(rows.length).toBe(before.length);
      expect(rows).toEqual(before);
      expect(synced).toEqual([]);
    });
  }

  test('an XMTP key XMTP would not open an inbox for leaves the table as it was', async () => {
    const before = await seed();
    xmtpInboxFails = true;
    const res = await start(session('ada@lovelace.dev'), 'agent000001', { station: 'xmtp' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as AttachBody).error).toContain(
      'did not register an inbox',
    );
    expect(rows.length).toBe(before.length);
    expect(rows).toEqual(before);
    expect(synced).toEqual([]);
  });

  test('a refused attach never reports a one-time secret', async () => {
    xmtpInboxFails = true;
    const res = await start(session('ada@lovelace.dev'), 'agent000001', { station: 'xmtp' });
    expect(await res.text()).not.toContain(FAKE_KEY);
    expect(rows).toEqual([]);
  });

  test('a write that fails after a good credential discards what the check created', async () => {
    const before = await seed();
    attachFails = true;
    const res = await start(session('ada@lovelace.dev'), 'agent000001', { station: 'xmtp' });
    expect(res.status).toBe(500);
    expect(discarded).toBe(1);
    expect(rows).toEqual(before);
    expect(synced).toEqual([]);
  });

  test('a verified XMTP key is stored with the inbox it opened', async () => {
    const res = await start(session('ada@lovelace.dev'), 'agent000001', { station: 'xmtp' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as AttachBody).identity).toEqual({
      inboxId: 'inbox-f00d',
    });
    expect(rows[0]?.config).toEqual({
      privateKey: FAKE_KEY,
      dbPath: '~/.metro/xmtp-production-f00d.db3',
    });
    expect(discarded).toBe(0);
  });
});

describe('DELETE /api/agents/:id/accounts/:station/:account', () => {
  const attachOne = async (email: string, agentId: string): Promise<string> => {
    const res = await start(session(email), agentId, {
      station: 'telegram-bot',
      token: `${FAKE_TOKEN}-${agentId}`,
    });
    return ((await res.json()) as AttachBody).accountId ?? '';
  };

  test('the owner detaches their own account and the station reloads', async () => {
    const id = await attachOne('ada@lovelace.dev', 'agent000001');
    synced = [];
    const res = await detach(session('ada@lovelace.dev'), 'agent000001', `telegram-bot/${id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      agentId: 'agent000001',
      station: 'telegram-bot',
      accountId: id,
      detached: true,
      activated: true,
    });
    expect(rows).toEqual([]);
    expect(synced).toEqual(['telegram-bot']);
  });

  test('another owner cannot detach it', async () => {
    const id = await attachOne('ada@lovelace.dev', 'agent000001');
    const res = await detach(session('bob@builder.dev'), 'agent000001', `telegram-bot/${id}`);
    expect(res.status).toBe(404);
    expect(rows.length).toBe(1);
  });

  test('detaching without a session removes nothing', async () => {
    const id = await attachOne('ada@lovelace.dev', 'agent000001');
    expect((await detach(undefined, 'agent000001', `telegram-bot/${id}`)).status).toBe(401);
    expect(rows.length).toBe(1);
  });

  test('an unknown account on an owned agent is 404', async () => {
    const res = await detach(session('ada@lovelace.dev'), 'agent000001', 'telegram-bot/a1-ffff');
    expect(res.status).toBe(404);
  });

  test('an unknown station name never reaches the database', async () => {
    const res = await detach(session('ada@lovelace.dev'), 'agent000001', 'nope/a1-0000');
    expect(res.status).toBe(404);
    expect(((await res.json()) as AttachBody).error).toBe('no such agent');
  });

  test('a path-traversing account id is refused', async () => {
    for (const bad of ['telegram-bot/..', 'telegram-bot/a1%20b', 'telegram-bot/A1-XX']) {
      expect((await detach(session('ada@lovelace.dev'), 'agent000001', bad)).status).toBe(404);
    }
  });

  test('POST on an account path is 405', async () => {
    const res = await fetch(`${base}/api/agents/agent000001/accounts/telegram-bot/a1-0000`, {
      method: 'POST',
      headers: { authorization: await auth('POST', `${base}/api/agents/agent000001/accounts/telegram-bot/a1-0000`, 'ada@lovelace.dev') },
    });
    expect(res.status).toBe(405);
  });
});

describe('GET /api/agents advertises what can be attached', () => {
  test('lists the attachable stations', async () => {
    const res = await fetch(`${base}/api/agents?project=${PROJECT}`, {
      headers: { authorization: await auth('GET', `${base}/api/agents?project=${PROJECT}`, 'ada@lovelace.dev') },
    });
    const body = (await res.json()) as { attachable?: string[] };
    expect(body.attachable).toEqual([
      'discord-bot',
      'telegram-bot',
      'xmtp',
      'webhook',
      'telegram',
      'whatsapp',
    ]);
  });
});

interface SessionBody {
  attachId?: string;
  status?: string;
  step?: string | null;
  error?: string;
  cancelled?: boolean;
}

const sessionUrl = (agentId: string, attachId: string): string =>
  `${base}/api/agents/${agentId}/accounts/${attachId}`;

const startSession = async (email: string, agentId = 'agent000001'): Promise<string> => {
  const res = await start(session(email), agentId, {
    station: 'telegram',
    apiId: 1,
    apiHash: 'ff',
    phone: '447700900123',
  });
  return ((await res.json()) as SessionBody).attachId ?? '';
};

describe('interactive attach sessions over HTTP', () => {
  afterEach(async () => {
    await attachSessions.stop();
  });

  test('start returns a pending session instead of a finished account', async () => {
    const res = await start(session('ada@lovelace.dev'), 'agent000001', {
      station: 'telegram',
      apiId: 1,
      apiHash: 'ff',
      phone: '447700900123',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SessionBody;
    expect(body.status).toBe('pending');
    expect(body.step).toBe('code');
    expect(body.attachId).toMatch(/^as_[A-Za-z0-9_-]{22}$/);
    expect(rows).toEqual([]);
  });

  test('a step signs in and lands the account', async () => {
    const attachId = await startSession('ada@lovelace.dev');
    const res = await fetch(`${sessionUrl('agent000001', attachId)}/step`, {
      method: 'POST',
      headers: {
        authorization: await auth('POST', `${sessionUrl('agent000001', attachId)}/step`, 'ada@lovelace.dev'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: '12345' }),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    const poll = await fetch(sessionUrl('agent000001', attachId), {
      headers: { authorization: await auth('GET', sessionUrl('agent000001', attachId), 'ada@lovelace.dev') },
    });
    expect(((await poll.json()) as SessionBody).status).toBe('done');
    expect(rows[0]?.station).toBe('telegram');
  });

  test('the stored session string is never served back', async () => {
    const attachId = await startSession('ada@lovelace.dev');
    await fetch(`${sessionUrl('agent000001', attachId)}/step`, {
      method: 'POST',
      headers: {
        authorization: await auth('POST', `${sessionUrl('agent000001', attachId)}/step`, 'ada@lovelace.dev'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: '12345' }),
    });
    await new Promise((r) => setTimeout(r, 10));
    const poll = await fetch(sessionUrl('agent000001', attachId), {
      headers: { authorization: await auth('GET', sessionUrl('agent000001', attachId), 'ada@lovelace.dev') },
    });
    expect(await poll.text()).not.toContain('fake-session-for-');
  });

  test('another signed-in user cannot poll or step somebody else session', async () => {
    const attachId = await startSession('ada@lovelace.dev');
    const bob = (method: string, url: string): Promise<string> => auth(method, url, 'bob@builder.dev');
    expect(
      (await fetch(sessionUrl('agent000001', attachId), { headers: { authorization: await bob('GET', sessionUrl('agent000001', attachId)) } })).status,
    ).toBe(404);
    const step = await fetch(`${sessionUrl('agent000001', attachId)}/step`, {
      method: 'POST',
      headers: { authorization: await bob('POST', `${sessionUrl('agent000001', attachId)}/step`), 'content-type': 'application/json' },
      body: JSON.stringify({ code: '12345' }),
    });
    expect(step.status).toBe(404);
    expect(rows).toEqual([]);
  });

  test('polling without a session is 401', async () => {
    const attachId = await startSession('ada@lovelace.dev');
    expect((await fetch(sessionUrl('agent000001', attachId))).status).toBe(401);
  });

  test('cancelling drops the session', async () => {
    const attachId = await startSession('ada@lovelace.dev');
    const res = await fetch(sessionUrl('agent000001', attachId), {
      method: 'DELETE',
      headers: { authorization: await auth('DELETE', sessionUrl('agent000001', attachId), 'ada@lovelace.dev') },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SessionBody).cancelled).toBe(true);
    const poll = await fetch(sessionUrl('agent000001', attachId), {
      headers: { authorization: await auth('GET', sessionUrl('agent000001', attachId), 'ada@lovelace.dev') },
    });
    expect(poll.status).toBe(404);
  });

  test('an id that is not an attach id never reaches the session store', async () => {
    for (const bad of ['as_short', 'as_' + 'x'.repeat(30), 'notasession']) {
      const res = await fetch(sessionUrl('agent000001', bad), {
        headers: { authorization: await auth('GET', sessionUrl('agent000001', bad), 'ada@lovelace.dev') },
      });
      expect(res.status).toBe(404);
    }
  });

  test('an operator agent is refused before any login is attempted', async () => {
    const res = await start(session('ada@lovelace.dev'), 'agent000005', {
      station: 'whatsapp',
      phone: '447700900123',
    });
    expect(res.status).toBe(404);
    expect(rows).toEqual([]);
  });

  test('an interactive sign-in on somebody else agent is a flat 404', async () => {
    const res = await start(session('ada@lovelace.dev'), 'agent000002', {
      station: 'telegram',
      apiId: 1,
      apiHash: 'ff',
      phone: '447700900123',
    });
    expect(res.status).toBe(404);
    expect(rows).toEqual([]);
  });

  test('a station that refuses the input is a 400 with no session left behind', async () => {
    const res = await start(session('ada@lovelace.dev'), 'agent000001', {
      station: 'whatsapp',
      phone: 'reject',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as SessionBody).error).toContain('refused');
  });

  test('PUT on a session path is 405', async () => {
    const attachId = await startSession('ada@lovelace.dev');
    const res = await fetch(sessionUrl('agent000001', attachId), {
      method: 'PUT',
      headers: { authorization: await auth('PUT', sessionUrl('agent000001', attachId), 'ada@lovelace.dev') },
    });
    expect(res.status).toBe(405);
  });
});

describe('a sign-in that never completes leaves the accounts table alone', () => {
  afterEach(async () => {
    await attachSessions.stop();
  });

  const seed = async (): Promise<Row[]> => {
    await start(session('ada@lovelace.dev'), 'agent000001', {
      station: 'telegram-bot',
      token: `${FAKE_TOKEN}-seed`,
    });
    synced = [];
    return structuredClone(rows);
  };

  const poll = async (attachId: string): Promise<SessionBody> => {
    await new Promise((r) => setTimeout(r, 10));
    const res = await fetch(sessionUrl('agent000001', attachId), {
      headers: { authorization: await auth('GET', sessionUrl('agent000001', attachId), 'ada@lovelace.dev') },
    });
    return (await res.json()) as SessionBody;
  };

  const step = async (attachId: string, code: string): Promise<Response> =>
    fetch(`${sessionUrl('agent000001', attachId)}/step`, {
      method: 'POST',
      headers: {
        authorization: await auth('POST', `${sessionUrl('agent000001', attachId)}/step`, 'ada@lovelace.dev'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code }),
    });

  test('a Telegram code the provider refuses fails the session and writes nothing', async () => {
    const before = await seed();
    const attachId = await startSession('ada@lovelace.dev');
    expect((await step(attachId, '000000')).status).toBe(200);
    const view = await poll(attachId);
    expect(view.status).toBe('failed');
    expect(view.error).toContain('not right');
    expect(rows.length).toBe(before.length);
    expect(rows).toEqual(before);
    expect(synced).toEqual([]);
  });

  test('a WhatsApp pairing the handset refuses writes nothing', async () => {
    const before = await seed();
    const res = await start(session('ada@lovelace.dev'), 'agent000001', {
      station: 'whatsapp',
      phone: 'handset-refuses',
    });
    const attachId = ((await res.json()) as SessionBody).attachId ?? '';
    expect((await poll(attachId)).status).toBe('failed');
    expect(rows.length).toBe(before.length);
    expect(rows).toEqual(before);
    expect(synced).toEqual([]);
  });

  test('a sign-in abandoned before it finishes writes nothing', async () => {
    const before = await seed();
    const attachId = await startSession('ada@lovelace.dev');
    await fetch(sessionUrl('agent000001', attachId), {
      method: 'DELETE',
      headers: { authorization: await auth('DELETE', sessionUrl('agent000001', attachId), 'ada@lovelace.dev') },
    });
    expect(rows.length).toBe(before.length);
    expect(rows).toEqual(before);
    expect(synced).toEqual([]);
  });

  test('a sign-in that does complete is the only one that adds a row', async () => {
    const before = await seed();
    const attachId = await startSession('ada@lovelace.dev');
    await step(attachId, '12345');
    expect((await poll(attachId)).status).toBe('done');
    expect(rows.length).toBe(before.length + 1);
    expect(rows.at(-1)?.station).toBe('telegram');
  });
});
