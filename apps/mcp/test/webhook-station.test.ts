import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { subscribeEvents, type MetroEvent } from '../src/daemon/events.ts';
import { listEndpoints } from '../src/daemon/tunnel.ts';
import { setTrainCallBackend } from '../src/daemon/train-call.ts';
import { setAgentMap } from '../src/db/agent-map.ts';
import { setKeyMap } from '../src/db/key-map.ts';
import { gatherAccountsForAgents } from '../src/mcp/accounts.ts';
import { newWebhookId, prepareAccount } from '../src/stations/attach.ts';
import { stationByName } from '../src/stations/registry.ts';

const SECRET = 'Zx-Egym_QEc7slzQR37KDtVFZ1wrZaZb1NcXFED2uNI';
const OPEN_SECRET = 'b'.repeat(43);
const SIGNED = 'a1-signed';
const OPEN = 'a1-open';
const SIGNED_HOOK = '1493556940637339623';
const OPEN_HOOK = '7002884113995117460';

let dir: string;
let accountsFile: string;
let priorFile: string | undefined;
let priorPublic: string | undefined;

const write = (records: unknown[]): void => {
  writeFileSync(accountsFile, JSON.stringify(records));
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-webhook-station-'));
  accountsFile = join(dir, 'webhook-accounts.json');
  priorFile = process.env.WEBHOOK_ACCOUNTS_FILE;
  priorPublic = process.env.METRO_PUBLIC_URL;
  process.env.WEBHOOK_ACCOUNTS_FILE = accountsFile;
  process.env.METRO_PUBLIC_URL = 'https://hooks.metro.test/';
});

afterAll(() => {
  if (priorFile === undefined) delete process.env.WEBHOOK_ACCOUNTS_FILE;
  else process.env.WEBHOOK_ACCOUNTS_FILE = priorFile;
  if (priorPublic === undefined) delete process.env.METRO_PUBLIC_URL;
  else process.env.METRO_PUBLIC_URL = priorPublic;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  write([
    { id: SIGNED, webhookId: SIGNED_HOOK, label: 'github', secret: SECRET },
    { id: OPEN, webhookId: OPEN_HOOK, label: 'open', secret: OPEN_SECRET },
    { id: 'a1-nosecret', webhookId: '5000000000000000001', label: 'legacy' },
  ]);
});

describe('webhook is an account station with no train', () => {
  test('the registry says it has accounts and no subprocess', () => {
    const station = stationByName('webhook');
    expect(station?.hasAccounts).toBe(true);
    expect(station?.hasTrain).toBe(false);
  });

  test('endpoints come from the materialized account file', () => {
    expect(listEndpoints().map((e) => e.id)).toEqual([
      SIGNED,
      OPEN,
      'a1-nosecret',
    ]);
    expect(listEndpoints()[0]?.secret).toBe(SECRET);
  });

  test('an account file that is not a list is ignored, never thrown on', () => {
    write([]);
    writeFileSync(accountsFile, '{"nope":true}');
    expect(listEndpoints()).toEqual([]);
  });
});

describe('attaching a webhook mints a secret and its own url', () => {
  test('the url carries its own webhook id, never the account id', async () => {
    const prepared = await prepareAccount({ station: 'webhook' });
    const { secret, webhookId } = prepared.config as {
      secret: string;
      webhookId: string;
    };
    expect(secret).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(webhookId).toMatch(/^[0-9]{19}$/);
    expect(prepared.identity).toEqual({
      endpoint: `https://hooks.metro.test/api/webhooks/${webhookId}/${secret}`,
    });
  });

  test('the public id gives away neither the agent nor the account', async () => {
    const prepared = await prepareAccount({ station: 'webhook' });
    const { webhookId } = prepared.config as { webhookId: string };
    expect(webhookId).not.toContain('-');
    expect(newWebhookId()).not.toBe(newWebhookId());
    const ids = new Set(Array.from({ length: 200 }, () => newWebhookId()));
    expect(ids.size).toBe(200);
  });

  test('the token is never handed back as a separate one-time secret', async () => {
    const prepared = await prepareAccount({ station: 'webhook' });
    expect(prepared.secret).toBeUndefined();
  });

  test('two attaches never share a token', async () => {
    const one = (await prepareAccount({ station: 'webhook' })).config;
    const two = (await prepareAccount({ station: 'webhook' })).config;
    expect((one as { secret: string }).secret).not.toBe(
      (two as { secret: string }).secret,
    );
  });

  test('no provider is contacted, so nothing can be discarded', async () => {
    const prepared = await prepareAccount({ station: 'webhook' });
    expect(prepared.discard).toBeUndefined();
    expect(Object.keys(prepared.identity)).toEqual(['endpoint']);
  });
});

describe('an in-core station is never reported as unavailable', () => {
  afterEach(() => {
    setAgentMap({}, {});
  });

  test('every train being down leaves webhook listed with its endpoints', async () => {
    setAgentMap({ [`webhook/${SIGNED}`]: 'agent000001', [`webhook/${OPEN}`]: 'agent000002' }, { ['agent000001']: 'Tony' });
    setTrainCallBackend(() => Promise.reject(new Error('train restarting')));
    const { accounts, unavailable } = await gatherAccountsForAgents(new Set(['agent000001']));
    expect(unavailable).not.toContain('webhook');
    expect(accounts.webhook).toEqual([
      {
        id: SIGNED,
        handle: `/api/webhooks/${SIGNED_HOOK}`,
        endpoint: `https://hooks.metro.test/api/webhooks/${SIGNED_HOOK}/${SECRET}`,
        agentId: 'agent000001',
      },
    ]);
  });

  test('an endpoint owned by another agent is not listed', async () => {
    setAgentMap({ [`webhook/${SIGNED}`]: 'agent000001', [`webhook/${OPEN}`]: 'agent000002' }, { ['agent000002']: 'Lisa' });
    setTrainCallBackend(() => Promise.reject(new Error('train restarting')));
    const { accounts } = await gatherAccountsForAgents(new Set(['agent000002']));
    expect((accounts.webhook as { id: string }[]).map((a) => a.id)).toEqual([OPEN]);
  });

  test('an endpoint with no token is unaddressable, so it is not listed', async () => {
    setAgentMap({ 'webhook/a1-nosecret': 'agent000002' }, { ['agent000002']: 'Lisa' });
    setTrainCallBackend(() => Promise.reject(new Error('train restarting')));
    const { accounts } = await gatherAccountsForAgents(new Set(['agent000002']));
    expect(accounts.webhook).toEqual([]);
  });
});

describe('the /hook route', () => {
  let server: Server;
  let base: string;
  let seen: MetroEvent[];
  let unsubscribe: () => void;

  beforeEach(async () => {
    process.env.METRO_WEBHOOK_PORT = String(
      24000 + Math.floor(Math.random() * 12000),
    );
    process.env.METRO_HTTP_HOST = '127.0.0.1';
    seen = [];
    setKeyMap([{ key: 'mk_monitor_is_mounted', agentId: 'agent000001' }]);
    unsubscribe = subscribeEvents((e: MetroEvent) => seen.push(e));
    server = await startWebhookServer(makeEmit(), undefined, () =>
      Promise.resolve({ result: null }),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    unsubscribe();
    setKeyMap([]);
    await new Promise<void>((r) => server.close(() => r()));
  });

  const hook = (webhookId: string, token: string): string =>
    `${base}/api/webhooks/${webhookId}/${token}`;

  test('a post to the full url emits one event on the endpoint own line', async () => {
    const res = await fetch(hook(SIGNED_HOOK, SECRET), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'd-1',
      },
      body: JSON.stringify({ action: 'opened' }),
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(String(seen[0]?.line)).toBe(`metro://webhook/${SIGNED}`);
    expect(seen[0]?.station).toBe('webhook');
    expect(seen[0]?.messageId).toBe('d-1');
    expect(seen[0]?.payload).toMatchObject({ body: { action: 'opened' } });
  });

  test('the summary line names the path without the token', async () => {
    await fetch(hook(SIGNED_HOOK, SECRET), { method: 'POST', body: '{}' });
    expect(seen[0]?.text).toBe(`event POST /api/webhooks/${SIGNED_HOOK}`);
    expect(JSON.stringify(seen[0])).not.toContain(SECRET);
  });

  test('no signature header is needed at all', async () => {
    const res = await fetch(hook(OPEN_HOOK, OPEN_SECRET), {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(String(seen[0]?.line)).toBe(`metro://webhook/${OPEN}`);
  });

  test('a wrong token is refused and emits nothing', async () => {
    const res = await fetch(hook(SIGNED_HOOK, 'f'.repeat(43)), {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  test('another endpoint token never opens this one', async () => {
    const res = await fetch(hook(SIGNED_HOOK, OPEN_SECRET), {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  test('the id alone, with no token, is not a route', async () => {
    for (const path of [
      `/api/webhooks/${SIGNED_HOOK}`,
      `/api/webhooks/${SIGNED_HOOK}/`,
      `/api/webhooks/${SIGNED}/${SECRET}`,
      `/hook/${SIGNED_HOOK}/${SECRET}`,
      `/wh/${SIGNED}`,
    ]) {
      const res = await fetch(`${base}${path}`, { method: 'POST', body: '{}' });
      expect([path, res.status]).toEqual([path, 404]);
    }
    expect(seen).toHaveLength(0);
  });

  test('an endpoint with no stored token can never be addressed', async () => {
    for (const token of ['', 'a'.repeat(43), SECRET]) {
      const res = await fetch(`${base}/api/webhooks/5000000000000000001/${token}`, {
        method: 'POST',
        body: '{}',
      });
      expect(res.status).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  test('an unknown endpoint is a 404 and emits nothing', async () => {
    const res = await fetch(hook('9999999999999999999', SECRET), {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  test('an endpoint detached since the last materialize stops accepting', async () => {
    write([
      { id: OPEN, webhookId: OPEN_HOOK, label: 'open', secret: OPEN_SECRET },
    ]);
    const res = await fetch(hook(SIGNED_HOOK, SECRET), {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  test('the monitor router claims /api/* and must not swallow this one', async () => {
    expect(
      (await fetch(`${base}/api/tail`, { method: 'GET' })).status,
    ).toBe(401);
    const res = await fetch(hook(SIGNED_HOOK, SECRET), {
      method: 'POST',
      body: '{"through":"the api prefix"}',
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  test('a GET confirms the endpoint is live without emitting', async () => {
    const res = await fetch(hook(SIGNED_HOOK, SECRET));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SIGNED_HOOK);
    expect(seen).toHaveLength(0);
  });

  test('a verb that is neither GET nor POST is refused', async () => {
    const res = await fetch(hook(SIGNED_HOOK, SECRET), { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(seen).toHaveLength(0);
  });
});
