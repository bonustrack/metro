import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { allowLocalConnectors } from '../src/daemon/connector-url.ts';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSessionApis, type SessionApis } from '../src/daemon/session-apis.js';
import { localSessionApis } from '../src/daemon/local-mode.js';
import { ensureLocalSessionSecret } from '../src/daemon/local-secret.js';
import { signSession } from '../src/daemon/session.js';
import { setLocalOwner } from '../src/db/file-admin.js';
import { agentIdForKey, setKeyMap } from '../src/db/key-map.js';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const STRANGER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const GOOD = `ma_${'x'.repeat(16)}`;
const WEBHOOK = `ma_${'w'.repeat(16)}`;
const TONY_KEY = `mk_${'b'.repeat(43)}`;
const TONY = {
  id: 'agentTony01',
  name: 'Tony',
  key: TONY_KEY,
  accounts: [
    { station: 'telegram-bot', id: 'stn00000001', allowlist: ['*'], config: { token: 'bot-token' } },
    { station: 'xmtp', id: 'stn00000002', allowlist: ['*'], config: { privateKey: '0x1', dbPath: '~/.metro/x.db3' } },
  ],
  connectors: [
    {
      id: 'conn0000001',
      name: 'linear',
      url: 'https://mcp.linear.app/mcp',
      transport: 'http',
      config: { auth: { kind: 'header', name: 'Authorization', value: 'Bearer vendor' }, createdAt: '2026-09-01T00:00:00.000Z', verified: { at: '2026-09-01T00:00:00.000Z', server: 'linear', tools: [] } },
    },
  ],
};
const saved = {
  dir: process.env.METRO_AGENTS_DIR,
  secret: process.env.METRO_SESSION_SECRET,
  url: process.env.METRO_URL,
  config: process.env.METRO_CONFIG_DIR,
};
let dir = '';
let metro: Server;
let local: Server;
let base = '';
let secret = '';
const synced: string[] = [];
const claims: unknown[] = [];

function fakeMetro(): Server {
  return createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
    });
    req.on('end', () => {
      const path = req.url ?? '';
      if (req.method === 'POST' && path === '/api/run/claim') {
        const body = JSON.parse(raw) as { code?: string; label?: string };
        claims.push(body);
        if (body.code === GOOD) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ token: 'rt-1', agent: TONY.id, label: body.label }));
        } else if (body.code === WEBHOOK) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'agent holds a webhook station and cannot move' }));
        } else {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no such code' }));
        }
        return;
      }
      if (req.method === 'GET' && path === '/api/run/config') {
        if (req.headers.authorization !== 'Bearer rt-1') {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ agent: TONY }));
        return;
      }
      res.writeHead(404).end();
    });
  });
}

const listen = (server: Server): Promise<string> =>
  new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      done(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
    });
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-import-'));
  process.env.METRO_AGENTS_DIR = dir;
  process.env.METRO_CONFIG_DIR = join(dir, 'config');
  delete process.env.METRO_SESSION_SECRET;
  secret = ensureLocalSessionSecret(dir);
  setKeyMap([]);
  setLocalOwner(OWNER, dir);
  metro = fakeMetro();
  process.env.METRO_URL = await listen(metro);
  const apis: SessionApis = localSessionApis({
    syncStations: (station) => {
      synced.push(station);
      return Promise.resolve();
    },
    closeAgentSession: () => Promise.resolve(true),
    gatherAccounts: () => Promise.resolve({ accounts: {}, unavailable: [] }),
    capabilities: () => ({}),
    liveness: () => new Map(),
    prepareAccount: () => Promise.reject(new Error('not used')),
  });
  local = createServer((req, res) => {
    if (handleSessionApis(req, res, apis)) return;
    res.writeHead(404).end();
  });
  base = await listen(local);
});

afterAll(() => {
  allowLocalConnectors(false);
});

afterAll(() => {
  local.close();
  metro.close();
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of [
    ['METRO_AGENTS_DIR', saved.dir],
    ['METRO_SESSION_SECRET', saved.secret],
    ['METRO_URL', saved.url],
    ['METRO_CONFIG_DIR', saved.config],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

const post = (token: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/agents/import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const session = (subject: string): string => signSession({ subject, agentIds: [] }, secret);

describe('importing an agent from metro.box into a local daemon', () => {
  test('a malformed code never reaches metro', async () => {
    const res = await post(session(OWNER), { code: 'nope' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('pairing code');
    expect(claims).toEqual([]);
  });

  test('a stranger is refused before the code is spent', async () => {
    expect((await post(session(STRANGER), { code: GOOD })).status).toBe(404);
    expect(claims).toEqual([]);
  });

  test('the good code claims the agent, writes its file with the same id and key, and reloads its stations', async () => {
    const res = await post(session(OWNER), { code: GOOD });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: TONY.id, name: 'Tony', key: TONY_KEY, stations: 2, connectors: 1 });
    expect(claims).toHaveLength(1);
    const file = JSON.parse(readFileSync(join(dir, 'Tony', 'agent.json'), 'utf8')) as {
      id: string;
      key: string;
      owner: string;
      stations: { station: string; id: string; config: Record<string, unknown> }[];
    };
    expect(file).toMatchObject({ id: TONY.id, key: TONY_KEY, owner: OWNER });
    expect(file.stations.map((s) => `${s.station}/${s.id}`)).toEqual([
      'telegram-bot/stn00000001',
      'xmtp/stn00000002',
    ]);
    expect(file.stations[1]?.config).toEqual({ privateKey: '0x1', dbPath: '~/.metro/x.db3' });
    expect(agentIdForKey(TONY_KEY)).toBe(TONY.id);
    const held = JSON.parse(readFileSync(join(dir, 'Tony', 'agent.json'), 'utf8')) as { connectors: string[] };
    expect(held.connectors).toEqual(['conn0000001']);
    const rows = JSON.parse(readFileSync(join(dir, 'connectors.json'), 'utf8')) as { connectors: { id: string; name: string; config: { auth: { value?: string } } }[] };
    expect(rows.connectors.map((c) => [c.id, c.name, c.config.auth.value])).toEqual([['conn0000001', 'linear', 'Bearer vendor']]);
    expect(synced.sort()).toEqual(['telegram-bot', 'xmtp']);
    const stored = JSON.parse(readFileSync(join(dir, 'config', `runtime-${TONY.id}.json`), 'utf8')) as {
      token: string;
      url: string;
    };
    expect(stored).toEqual({ token: 'rt-1', url: process.env.METRO_URL });
    expect((statSync(join(dir, 'config', `runtime-${TONY.id}.json`)).mode & 0o777).toString(8)).toBe('600');
    const list = (await (await fetch(`${base}/api/agents?project=localdaemon`, {
      headers: { authorization: `Bearer ${session(OWNER)}` },
    })).json()) as { agents: { id: string; key: string }[] };
    expect(list.agents).toMatchObject([{ id: TONY.id, key: TONY_KEY }]);
  });

  test('importing it twice refreshes it in place, and metro refusals come through with their reason', async () => {
    const again = await post(session(OWNER), { code: GOOD });
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ id: TONY.id, name: 'Tony', key: TONY_KEY, stations: 2, connectors: 1 });
    const unknown = await post(session(OWNER), { code: `ma_${'z'.repeat(16)}` });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe('no such code');
    const webhook = await post(session(OWNER), { code: WEBHOOK });
    expect(webhook.status).toBe(409);
    expect(((await webhook.json()) as { error: string }).error).toContain('webhook');
    expect(existsSync(join(dir, 'Tony', 'agent.json'))).toBe(true);
  });

  test('only POST, and only with a session', async () => {
    expect((await fetch(`${base}/api/agents/import`)).status).toBe(405);
    expect((await fetch(`${base}/api/agents/import`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/api/agents/import`, { method: 'OPTIONS' })).status).toBe(204);
  });
});
