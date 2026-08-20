import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { createHmac } from 'node:crypto';
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
import { gatherAccountsForAgents } from '../src/mcp/accounts.ts';
import { prepareAccount } from '../src/stations/attach.ts';
import { stationByName } from '../src/stations/registry.ts';

const SECRET = 'a'.repeat(64);
const SIGNED = 'a1-signed';
const OPEN = 'a1-open';

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
    { id: SIGNED, label: 'github', secret: SECRET },
    { id: OPEN, label: 'open' },
  ]);
});

describe('webhook is an account station with no train', () => {
  test('the registry says it has accounts and no subprocess', () => {
    const station = stationByName('webhook');
    expect(station?.hasAccounts).toBe(true);
    expect(station?.hasTrain).toBe(false);
  });

  test('endpoints come from the materialized account file', () => {
    expect(listEndpoints().map((e) => e.id)).toEqual([SIGNED, OPEN]);
    expect(listEndpoints()[0]?.secret).toBe(SECRET);
  });

  test('an account file that is not a list is ignored, never thrown on', () => {
    write([]);
    writeFileSync(accountsFile, '{"nope":true}');
    expect(listEndpoints()).toEqual([]);
  });
});

describe('attaching a webhook mints a secret and its own url', () => {
  test('the secret is shown once and the url carries the generated id', async () => {
    const prepared = await prepareAccount({ station: 'webhook' });
    expect(prepared.secret?.value).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.config).toMatchObject({ secret: prepared.secret?.value });
    expect(prepared.finalize?.('a7-abcdef12')).toEqual({
      url: 'https://hooks.metro.test/wh/a7-abcdef12',
    });
  });

  test('two attaches never share a signing secret', async () => {
    const one = await prepareAccount({ station: 'webhook' });
    const two = await prepareAccount({ station: 'webhook' });
    expect(one.secret?.value).not.toBe(two.secret?.value);
  });

  test('no provider is contacted, so nothing can be discarded', async () => {
    const prepared = await prepareAccount({ station: 'webhook' });
    expect(prepared.discard).toBeUndefined();
    expect(prepared.identity).toEqual({});
  });
});

describe('an in-core station is never reported as unavailable', () => {
  afterEach(() => {
    setAgentMap({}, {});
  });

  test('every train being down leaves webhook listed with its endpoints', async () => {
    setAgentMap({ [`webhook/${SIGNED}`]: 1, [`webhook/${OPEN}`]: 2 }, { 1: 'Tony' });
    setTrainCallBackend(() => Promise.reject(new Error('train restarting')));
    const { accounts, unavailable } = await gatherAccountsForAgents(new Set([1]));
    expect(unavailable).not.toContain('webhook');
    expect(accounts.webhook).toEqual([
      {
        id: SIGNED,
        handle: `/wh/${SIGNED}`,
        url: `https://hooks.metro.test/wh/${SIGNED}`,
        signed: 'hmac-sha256',
        agentId: 1,
      },
    ]);
  });

  test('an endpoint owned by another agent is not listed', async () => {
    setAgentMap({ [`webhook/${SIGNED}`]: 1, [`webhook/${OPEN}`]: 2 }, { 2: 'Lisa' });
    setTrainCallBackend(() => Promise.reject(new Error('train restarting')));
    const { accounts } = await gatherAccountsForAgents(new Set([2]));
    expect((accounts.webhook as { id: string }[]).map((a) => a.id)).toEqual([OPEN]);
  });

  test('an endpoint with no secret says so, and no secret is ever listed', async () => {
    setAgentMap({ [`webhook/${OPEN}`]: 2 }, { 2: 'Lisa' });
    setTrainCallBackend(() => Promise.reject(new Error('train restarting')));
    const { accounts } = await gatherAccountsForAgents(new Set([2]));
    expect(accounts.webhook).toEqual([
      {
        id: OPEN,
        handle: `/wh/${OPEN}`,
        url: `https://hooks.metro.test/wh/${OPEN}`,
        signed: 'no',
        agentId: 2,
      },
    ]);
    expect(JSON.stringify(accounts)).not.toContain(SECRET);
  });
});

describe('the /wh route', () => {
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
    unsubscribe = subscribeEvents((e: MetroEvent) => seen.push(e));
    server = await startWebhookServer(makeEmit());
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    unsubscribe();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const sign = (body: string): string =>
    `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

  test('a signed post emits one event on the endpoint own line', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const res = await fetch(`${base}/wh/${SIGNED}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(body),
        'x-github-event': 'issues',
        'x-github-delivery': 'd-1',
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(String(seen[0]?.line)).toBe(`metro://webhook/${SIGNED}`);
    expect(seen[0]?.station).toBe('webhook');
    expect(seen[0]?.messageId).toBe('d-1');
    expect(seen[0]?.payload).toMatchObject({ body: { action: 'opened' } });
  });

  test('a wrong signature is refused and emits nothing', async () => {
    const res = await fetch(`${base}/wh/${SIGNED}`, {
      method: 'POST',
      headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test('a missing signature on a signed endpoint is refused', async () => {
    const res = await fetch(`${base}/wh/${SIGNED}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test('an endpoint with no secret accepts an unsigned post', async () => {
    const res = await fetch(`${base}/wh/${OPEN}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(String(seen[0]?.line)).toBe(`metro://webhook/${OPEN}`);
  });

  test('an unknown endpoint is a 404 and emits nothing', async () => {
    const res = await fetch(`${base}/wh/a1-never-attached`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  test('an endpoint detached since the last materialize stops accepting', async () => {
    write([{ id: OPEN, label: 'open' }]);
    const res = await fetch(`${base}/wh/${SIGNED}`, {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign('{}') },
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  test('a GET confirms the endpoint is live without emitting', async () => {
    const res = await fetch(`${base}/wh/${SIGNED}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SIGNED);
    expect(seen).toHaveLength(0);
  });

  test('a verb that is neither GET nor POST is refused', async () => {
    const res = await fetch(`${base}/wh/${SIGNED}`, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(seen).toHaveLength(0);
  });
});
