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
import { publicKeyOf } from '@metro-labs/threema/verify';
import { makeEmit, startWebhookServer } from '../src/routes/http.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { setAgentMap } from '../src/agents/map.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { gatherAccountsForAgents } from '../src/mcp/accounts.ts';
import { prepareAccount, StationAttachError } from '../src/stations/attach.ts';
import { stationByName } from '../src/stations/registry.ts';
import { listThreemaCallbacks } from '../src/stations/threema-callbacks.ts';

const KEY = '07'.repeat(32);
const PUBLIC = publicKeyOf(KEY);
const CALLBACK_ID = '1493556940637339623';
const CALLBACK_TOKEN = 'Zx-Egym_QEc7slzQR37KDtVFZ1wrZaZb1NcXFED2uNI';
const BASE = 'https://hooks.metro.test';

interface Call {
  train: string;
  action: string;
  args: Record<string, unknown>;
}

let dir: string;
let accountsFile: string;
let priorFile: string | undefined;
let priorPublic: string | undefined;
let realFetch: typeof fetch;

const gateway = (credits: string, pubkey: string) => (url: string): [number, string] =>
  url.includes('/credits') ? [200, credits] : [200, pubkey];

function stubFetch(answer: (url: string) => [number, string]): string[] {
  const urls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const [status, body] = answer(url);
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  return urls;
}

const form = (over: Record<string, string> = {}): string =>
  new URLSearchParams({
    from: 'ECHOECHO',
    to: '*METRO01',
    messageId: 'fedcba9876543210',
    date: '1700000000',
    nonce: 'aa'.repeat(24),
    box: 'bb'.repeat(40),
    mac: 'cc'.repeat(32),
    nickname: 'Alice',
    ...over,
  }).toString();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-threema-station-'));
  accountsFile = join(dir, 'threema-accounts.json');
  priorFile = process.env.THREEMA_ACCOUNTS_FILE;
  priorPublic = process.env.METRO_PUBLIC_URL;
  process.env.THREEMA_ACCOUNTS_FILE = accountsFile;
  process.env.METRO_PUBLIC_URL = `${BASE}/`;
  realFetch = globalThis.fetch;
});

afterAll(() => {
  if (priorFile === undefined) delete process.env.THREEMA_ACCOUNTS_FILE;
  else process.env.THREEMA_ACCOUNTS_FILE = priorFile;
  if (priorPublic === undefined) delete process.env.METRO_PUBLIC_URL;
  else process.env.METRO_PUBLIC_URL = priorPublic;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  writeFileSync(
    accountsFile,
    JSON.stringify([
      { id: 't0', gatewayId: '*METRO01', secret: 's3cret', privateKey: KEY, callbackId: CALLBACK_ID, callbackToken: CALLBACK_TOKEN },
      { id: 't1', gatewayId: '*METRO02', secret: 's', privateKey: KEY },
    ]),
  );
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('threema is an account station with a train', () => {
  test('the registry says so, and it carries send and reply only, with no attachments', () => {
    const station = stationByName('threema');
    expect(station?.hasAccounts).toBe(true);
    expect(station?.hasTrain).toBe(true);
    expect([...(station?.messageVerbs ?? [])].sort()).toEqual(['reply', 'send']);
    expect(station?.attachmentMode).toBe('none');
  });

  test('only an account with a callback id and token is addressable from outside', () => {
    expect(listThreemaCallbacks()).toEqual([{ id: 't0', callbackId: CALLBACK_ID, callbackToken: CALLBACK_TOKEN }]);
    writeFileSync(accountsFile, '{"nope":true}');
    expect(listThreemaCallbacks()).toEqual([]);
  });
});

describe('attaching a Threema Gateway ID', () => {
  test('verifies the credentials and the key with Threema, then mints the callback url', async () => {
    const urls = stubFetch(gateway('17', PUBLIC));
    const prepared = await prepareAccount({
      station: 'threema',
      gatewayId: ' *metro01 ',
      secret: 's3cret',
      privateKey: `private:${KEY.toUpperCase()}`,
    });
    const config = prepared.config as Record<string, string>;
    expect(config).toMatchObject({ gatewayId: '*METRO01', secret: 's3cret', privateKey: KEY });
    expect(config.callbackId).toMatch(/^[0-9]{19}$/);
    expect(config.callbackToken).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(prepared.identity).toEqual({
      gatewayId: '*METRO01',
      credits: '17',
      callback: `${BASE}/api/threema/${config.callbackId}/${config.callbackToken}`,
    });
    expect(prepared.secret).toBeUndefined();
    expect(urls.map((u) => u.split('?')[0])).toEqual([
      'https://msgapi.threema.ch/credits',
      'https://msgapi.threema.ch/pubkeys/*METRO01',
    ]);
  });

  test('a refused secret, a foreign key and a missing field are 400s that name the problem', async () => {
    stubFetch(() => [401, '']);
    const refused = await prepareAccount({ station: 'threema', gatewayId: '*METRO01', secret: 'bad', privateKey: KEY }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(StationAttachError);
    expect((refused as StationAttachError).status).toBe(400);
    expect((refused as Error).message).toBe('Threema rejected that Gateway ID or API secret');

    stubFetch(gateway('1', 'ab'.repeat(32)));
    const foreign = await prepareAccount({ station: 'threema', gatewayId: '*METRO01', secret: 's', privateKey: KEY }).catch((e: unknown) => e);
    expect((foreign as Error).message).toContain('does not belong to *METRO01');

    const missing = await prepareAccount({ station: 'threema', gatewayId: '*METRO01', secret: 's' }).catch((e: unknown) => e);
    expect((missing as Error).message).toBe('the Threema private key is required');
  });
});

describe('the callback route', () => {
  let server: Server;
  let base: string;
  let calls: Call[];
  let answer: () => Promise<{ result?: unknown; error?: string }>;

  beforeEach(async () => {
    process.env.METRO_WEBHOOK_PORT = String(12000 + Math.floor(Math.random() * 12000));
    process.env.METRO_HTTP_HOST = '127.0.0.1';
    calls = [];
    answer = () => Promise.resolve({ result: { ok: true, kind: 'text' } });
    setKeyMap([{ key: 'mk_monitor_is_mounted', agentId: 'agent000001' }]);
    setTrainCallBackend((train, action, args) => {
      calls.push({ train, action, args: args as Record<string, unknown> });
      return answer();
    });
    server = await startWebhookServer(makeEmit(), {}, undefined, () => Promise.resolve({ result: null }));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    setKeyMap([]);
    await new Promise<void>((r) => server.close(() => r()));
  });

  const post = (path: string, body: string): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  const hook = `/api/threema/${CALLBACK_ID}/${CALLBACK_TOKEN}`;

  test('a delivery on the full url is forwarded to the train, addressed to the owning account', async () => {
    const res = await post(hook, form());
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        train: 'threema',
        action: 'callback',
        args: {
          account: 't0',
          from: 'ECHOECHO',
          to: '*METRO01',
          messageId: 'fedcba9876543210',
          date: '1700000000',
          nonce: 'aa'.repeat(24),
          box: 'bb'.repeat(40),
          mac: 'cc'.repeat(32),
          nickname: 'Alice',
        },
      },
    ]);
  });

  test('a readiness probe answers without touching the train', async () => {
    const res = await fetch(`${base}${hook}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ready');
    expect((await fetch(`${base}${hook}`, { method: 'PUT' })).status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  test('a train that refuses the delivery is a 400, so Threema stops retrying', async () => {
    answer = () => Promise.resolve({ error: 'the callback MAC does not match this account API secret' });
    expect((await post(hook, form())).status).toBe(400);
  });

  test('a train that is down is a 503, so Threema retries later', async () => {
    answer = () => Promise.reject(new Error('train restarting'));
    expect((await post(hook, form())).status).toBe(503);
  });

  test('a field Threema always sends being absent is a 400 before the train is asked', async () => {
    expect((await post(hook, form({ box: '' }))).status).toBe(400);
    expect((await post(hook, 'not=a&threema=callback')).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('a wrong token, an unknown id, an account with no callback, and the bare id are all 404', async () => {
    for (const path of [
      `/api/threema/${CALLBACK_ID}/${'f'.repeat(43)}`,
      `/api/threema/7002884113995117460/${CALLBACK_TOKEN}`,
      `/api/threema/${CALLBACK_ID}`,
      `/api/threema/${CALLBACK_ID}/`,
      `/api/threema/t0/${CALLBACK_TOKEN}`,
    ]) {
      const res = await post(path, form());
      expect([path, res.status]).toEqual([path, 404]);
    }
    expect(calls).toHaveLength(0);
  });

  test('the route sits in front of the monitor router, which still guards /api/tail', async () => {
    const res = await fetch(`${base}/api/tail`);
    expect(res.status).toBe(401);
  });
});

describe('the accounts a daemon reports', () => {
  afterEach(() => {
    setAgentMap({}, {});
  });

  test('carry the callback url, never the token, and only for the owning agent', async () => {
    setAgentMap({ 'threema/t0': 'agent000001', 'threema/t1': 'agent000002' }, { agent000001: 'Tony' });
    setTrainCallBackend(() =>
      Promise.resolve({
        result: {
          accounts: [
            { id: 't0', handle: '*METRO01', url: null, owner: null, gatewayId: '*METRO01', callbackId: CALLBACK_ID, callbackToken: CALLBACK_TOKEN },
            { id: 't1', handle: '*METRO02', url: null, owner: null, gatewayId: '*METRO02' },
          ],
        },
      }),
    );
    const { accounts, unavailable } = await gatherAccountsForAgents(new Set(['agent000001']));
    expect(unavailable).not.toContain('threema');
    expect(accounts.threema).toEqual([
      {
        id: 't0',
        handle: '*METRO01',
        url: null,
        owner: null,
        gatewayId: '*METRO01',
        callback: `${BASE}/api/threema/${CALLBACK_ID}/${CALLBACK_TOKEN}`,
        agentId: 'agent000001',
      },
    ]);
    expect(JSON.stringify(accounts)).not.toContain('callbackToken');
  });
});
