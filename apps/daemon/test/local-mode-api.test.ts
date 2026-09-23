import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auth, TEST_OWNER, type Who } from './identity-helper.ts';
import { handleModeRequest } from '@metro-labs/http/mode-api';
import { handleSessionApis, type SessionApis } from '../src/routes/session-apis.js';
import { setLocalOwner, ensureLocalAgent } from '../src/agents/file-admin.ts';
import { localSessionApis } from '../src/routes/local-mode.js';
import { agentIdForKey, setKeyMap } from '../src/agents/keys.js';

const OWNER = TEST_OWNER;
const saved = {
  dir: process.env.METRO_AGENTS_DIR,
  port: process.env.METRO_WEBHOOK_PORT,
};
let dir = '';
let server: Server;
let base = '';
const synced: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-local-'));
  process.env.METRO_AGENTS_DIR = dir;
  process.env.METRO_WEBHOOK_PORT = '8420';
  setKeyMap([]);
  const apis: SessionApis = localSessionApis({
    syncStations: (station) => {
      synced.push(station);
      return Promise.resolve();
    },
    restart: () => undefined,
    stop: () => undefined,
    gatherAccounts: () => Promise.resolve({ accounts: {}, unavailable: [] }),
    capabilities: () => ({}),
    prepareAccount: (input) =>
      Promise.resolve({ config: { token: String(input.token) }, identity: { handle: '@bot' } }),
  });
  server = createServer((req, res) => {
    if (apis.mode && handleModeRequest(req, res, apis.mode)) return;
    if (handleSessionApis(req, res, apis)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  if (saved.dir === undefined) delete process.env.METRO_AGENTS_DIR;
  else process.env.METRO_AGENTS_DIR = saved.dir;
  if (saved.port === undefined) delete process.env.METRO_WEBHOOK_PORT;
  else process.env.METRO_WEBHOOK_PORT = saved.port;
});

const J = { 'content-type': 'application/json' };
const call = async (method: string, path: string, token?: Who, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: await auth(token) }),
      ...(body === undefined ? {} : J),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const session: Who = OWNER;
let agentId = '';
let key = '';

describe('a local daemon, end to end over http', () => {
  test('it says it is local and unowned, with the project field old pages read', async () => {
    expect(await (await call('GET', '/api/mode')).json()).toEqual({ mode: 'local', owner: null, project: 'localdaemon', version: expect.any(String) });
    expect((await call('OPTIONS', '/api/mode')).status).toBe(204);
    expect((await call('POST', '/api/mode')).status).toBe(405);
  });

  test('the operator sets the owner organization, and no session is still 401', async () => {
    setLocalOwner(OWNER, dir);
    expect(((await (await call('GET', '/api/mode')).json()) as { owner: string }).owner).toBe(OWNER);
    expect((await call('GET', '/api/agents')).status).toBe(401);
  });

  test('the daemon makes the agent itself; the list shows it, never its key', async () => {
    expect(await ensureLocalAgent(dir)).toBe('created');
    expect(existsSync(join(dir, 'agent.json'))).toBe(true);
    expect((await call('POST', `/api/agents`, session, { name: 'suzy' })).status).toBe(405);
    const list = (await (await call('GET', `/api/agents`, session)).json()) as {
      agents: { id: string; connector_ids: string[] }[];
    };
    const made = list.agents[0];
    if (made === undefined) throw new Error('expected the agent');
    agentId = made.id;
    key = (JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as { key: string }).key;
    expect(agentIdForKey(key)).toBe(agentId);
    expect(list.agents).toMatchObject([{ id: agentId, connector_ids: [] }]);
    expect(made).not.toHaveProperty('key');
    expect(made).not.toHaveProperty('endpoint');
  });

  test('attaching a station lands in the file and reloads that station', async () => {
    const res = await call('POST', `/api/agents/${agentId}/accounts/start`, session, {
      station: 'telegram-bot',
      token: '123456:abc',
    });
    expect(res.status).toBe(201);
    const file = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as {
      stations: { station: string; id: string; config: { token: string } }[];
    };
    expect(file.stations).toMatchObject([{ station: 'telegram-bot', config: { token: '123456:abc' } }]);
    expect(synced).toEqual(['telegram-bot']);
    const again = await call('POST', `/api/agents/${agentId}/accounts/start`, session, {
      station: 'telegram-bot',
      token: '123456:abc',
    });
    expect(again.status).toBe(409);
    const gone = await call(
      'DELETE',
      `/api/agents/${agentId}/accounts/telegram-bot/${file.stations[0]?.id ?? ''}`,
      session,
    );
    expect(gone.status).toBe(200);
  });

  test('what a local daemon refuses: the key, delete, code, connector and runtime routes are gone', async () => {
    for (const [method, path] of [
      ['POST', `/api/agents/${agentId}/key`],
      ['DELETE', `/api/agents/${agentId}`],
      ['POST', `/api/agents/${agentId}/code`],
      ['POST', `/api/agents/${agentId}/connectors`],
      ['DELETE', `/api/agents/${agentId}/runtime`],
    ] as const)
      expect([path, (await call(method, path, session)).status]).toEqual([path, 404]);
    expect(existsSync(join(dir, 'agent.json'))).toBe(true);
    expect(agentIdForKey(key)).toBe(agentId);
  });
});
