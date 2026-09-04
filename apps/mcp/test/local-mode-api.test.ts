import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { allowLocalConnectors } from '../src/daemon/connector-url.ts';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { handleSiweAuthRequest } from '../src/daemon/siwe-routes.js';
import { handleModeRequest } from '../src/daemon/mode-api.js';
import { handleSessionApis, type SessionApis } from '../src/daemon/session-apis.js';
import { setLocalOwner } from '../src/db/file-admin.ts';
import { localSessionApis } from '../src/daemon/local-mode.js';
import { ensureLocalSessionSecret } from '../src/daemon/local-secret.js';
import { signSession } from '../src/daemon/session.js';
import { agentIdForKey, setKeyMap } from '../src/db/key-map.js';

const OWNER = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const STRANGER = privateKeyToAccount(
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
);
const PROJECT = 'localdaemon';
const saved = {
  dir: process.env.METRO_AGENTS_DIR,
  secret: process.env.METRO_SESSION_SECRET,
  port: process.env.METRO_WEBHOOK_PORT,
};
let dir = '';
let server: Server;
let base = '';
let secret = '';
const synced: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-local-'));
  process.env.METRO_AGENTS_DIR = dir;
  process.env.METRO_WEBHOOK_PORT = '8420';
  delete process.env.METRO_SESSION_SECRET;
  secret = ensureLocalSessionSecret(dir);
  setKeyMap([]);
  const apis: SessionApis = localSessionApis({
    syncStations: (station) => {
      synced.push(station);
      return Promise.resolve();
    },
    closeAgentSession: () => Promise.resolve(true),
    gatherAccounts: () => Promise.resolve({ accounts: {}, unavailable: [] }),
    capabilities: () => ({}),
    liveness: () => new Map(),
    prepareAccount: (input) =>
      Promise.resolve({ config: { token: String(input.token) }, identity: { handle: '@bot' } }),
  });
  server = createServer((req, res) => {
    if (handleSiweAuthRequest(req, res, apis.siwe)) return;
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
  allowLocalConnectors(false);
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  if (saved.dir === undefined) delete process.env.METRO_AGENTS_DIR;
  else process.env.METRO_AGENTS_DIR = saved.dir;
  if (saved.secret === undefined) delete process.env.METRO_SESSION_SECRET;
  else process.env.METRO_SESSION_SECRET = saved.secret;
  if (saved.port === undefined) delete process.env.METRO_WEBHOOK_PORT;
  else process.env.METRO_WEBHOOK_PORT = saved.port;
});

const J = { 'content-type': 'application/json' };
const call = (method: string, path: string, token?: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : J),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function signIn(account: typeof OWNER): Promise<Response> {
  const { nonce } = (await (await fetch(`${base}/auth/siwe/nonce`)).json()) as { nonce: string };
  const now = new Date();
  const message = createSiweMessage({
    address: account.address,
    chainId: 1,
    domain: 'metro.box',
    uri: 'https://metro.box',
    version: '1',
    nonce,
    issuedAt: now,
    expirationTime: new Date(now.getTime() + 600_000),
  });
  const signature = await account.signMessage({ message });
  return call('POST', '/auth/siwe/verify', undefined, { message, signature });
}

let session = '';
let agentId = '';
let key = '';

describe('a local daemon, end to end over http', () => {
  test('it says it is local, unowned, with a machine project, and minted its own secret', async () => {
    expect(await (await call('GET', '/api/mode')).json()).toEqual({ mode: 'local', owner: null, project: PROJECT, version: expect.any(String) });
    expect(secret.length).toBeGreaterThan(30);
    expect((statSync(join(dir, '.session-secret')).mode & 0o777).toString(8)).toBe('600');
    expect(ensureLocalSessionSecret(dir)).toBe(secret);
    expect((await call('OPTIONS', '/api/mode')).status).toBe(204);
    expect((await call('POST', '/api/mode')).status).toBe(405);
  });

  test('nobody can sign in until the operator sets the owner; then only that wallet can', async () => {
    expect((await signIn(OWNER)).status).toBe(403);
    setLocalOwner(OWNER.address, dir);
    const res = await signIn(OWNER);
    expect(res.status).toBe(200);
    session = ((await res.json()) as { session: string }).session;
    expect(((await (await call('GET', '/api/mode')).json()) as { owner: string }).owner).toBe(
      OWNER.address.toLowerCase(),
    );
    expect((await signIn(STRANGER)).status).toBe(403);
  });


  test('creating an agent writes its file, registers its key and lists it', async () => {
    const res = await call('POST', `/api/agents?project=${PROJECT}`, session, { name: 'suzy' });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { id: string; key: string; command: string };
    agentId = made.id;
    key = made.key;
    expect(made.command).toContain(`127.0.0.1:8420/mcp?token=${key}`);
    expect(existsSync(join(dir, 'suzy', 'agent.json'))).toBe(true);
    expect(agentIdForKey(key)).toBe(agentId);
    const list = (await (await call('GET', `/api/agents?project=${PROJECT}`, session)).json()) as {
      agents: { id: string; key: string; connector_ids: string[] }[];
    };
    expect(list.agents).toMatchObject([{ id: agentId, key, connector_ids: [] }]);
  });

  test('attaching a station lands in the file and reloads that station', async () => {
    const res = await call('POST', `/api/agents/${agentId}/accounts/start`, session, {
      station: 'telegram-bot',
      token: '123456:abc',
    });
    expect(res.status).toBe(201);
    const file = JSON.parse(readFileSync(join(dir, 'suzy', 'agent.json'), 'utf8')) as {
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

  test('a key reset rotates the file and the map; delete removes the file', async () => {
    const reset = (await (await call('POST', `/api/agents/${agentId}/key`, session)).json()) as { key: string };
    expect(reset.key).not.toBe(key);
    expect(agentIdForKey(reset.key)).toBe(agentId);
    expect(agentIdForKey(key)).toBeUndefined();
    expect((await call('DELETE', `/api/agents/${agentId}`, session)).status).toBe(200);
    expect(existsSync(join(dir, 'suzy'))).toBe(false);
  });

  test('what a local daemon refuses, and what a stranger sees', async () => {
    const made = (await (await call('POST', `/api/agents?project=${PROJECT}`, session, { name: 'tony' })).json()) as { id: string };
    expect((await call('POST', `/api/agents/${made.id}/code`, session)).status).toBe(404);
    expect((await call('POST', `/api/agents/${made.id}/connectors`, session, { connectorId: 'conn0000001' })).status).toBe(404);
    expect((await call('DELETE', `/api/agents/${made.id}/runtime`, session)).status).toBe(404);
    const stranger = signSession({ subject: STRANGER.address.toLowerCase(), agentIds: [] }, secret);
    expect((await call('GET', `/api/agents?project=${PROJECT}`, stranger)).status).toBe(404);
    expect((await call('GET', `/api/agents/${made.id}/connectors`, stranger)).status).toBe(404);
  });
});
