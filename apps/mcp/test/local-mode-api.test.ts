import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { allowLocalConnectors } from '../src/daemon/connector-url.ts';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { handleIdentityRequest } from '../src/daemon/identity-routes.js';
import { ENCRYPTION_KEY_TYPED_DATA, deriveIdentityKey } from '../src/daemon/identity-key.js';
import { auth, type Who } from './identity-helper.ts';
import { handleModeRequest } from '../src/daemon/mode-api.js';
import { handleSessionApis, type SessionApis } from '../src/daemon/session-apis.js';
import { setLocalOwner } from '../src/db/file-admin.ts';
import { localSessionApis } from '../src/daemon/local-mode.js';
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
    closeAgentSession: () => Promise.resolve(true),
    gatherAccounts: () => Promise.resolve({ accounts: {}, unavailable: [] }),
    capabilities: () => ({}),
    liveness: () => new Map(),
    prepareAccount: (input) =>
      Promise.resolve({ config: { token: String(input.token) }, identity: { handle: '@bot' } }),
  });
  server = createServer((req, res) => {
    if (apis.identity && handleIdentityRequest(req, res, apis.identity)) return;
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
  if (saved.port === undefined) delete process.env.METRO_WEBHOOK_PORT;
  else process.env.METRO_WEBHOOK_PORT = saved.port;
});

const J = { 'content-type': 'application/json' };
const call = async (method: string, path: string, token?: Who, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: await auth(method, path, token) }),
      ...(body === undefined ? {} : J),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function signIn(account: PrivateKeyAccount): Promise<Response> {
  const signature = await account.signTypedData(ENCRYPTION_KEY_TYPED_DATA);
  return call('POST', '/auth/identity', undefined, { signature });
}

async function identityOf(account: PrivateKeyAccount): Promise<PrivateKeyAccount> {
  return privateKeyToAccount(deriveIdentityKey(await account.signTypedData(ENCRYPTION_KEY_TYPED_DATA)));
}

let session: PrivateKeyAccount = STRANGER;
let agentId = '';
let key = '';

describe('a local daemon, end to end over http', () => {
  test('it says it is local, unowned, with a machine project', async () => {
    expect(await (await call('GET', '/api/mode')).json()).toEqual({ mode: 'local', owner: null, project: PROJECT, version: expect.any(String) });
    expect((await call('OPTIONS', '/api/mode')).status).toBe(204);
    expect((await call('POST', '/api/mode')).status).toBe(405);
  });

  test('nobody can sign in until the operator sets the owner; then only that wallet can, with one typed-data signature', async () => {
    expect((await signIn(OWNER)).status).toBe(403);
    setLocalOwner(OWNER.address, dir);
    const res = await signIn(OWNER);
    expect(res.status).toBe(200);
    session = await identityOf(OWNER);
    expect(await res.json()).toEqual({ address: session.address.toLowerCase(), owner: OWNER.address.toLowerCase() });
    expect(((await (await call('GET', '/api/mode')).json()) as { owner: string }).owner).toBe(
      OWNER.address.toLowerCase(),
    );
    expect((await signIn(STRANGER)).status).toBe(403);
    expect((await call('POST', '/auth/identity', undefined, { signature: '0x12' })).status).toBe(400);
    expect((await call('GET', '/auth/identity')).status).toBe(405);
    expect((await call('GET', `/api/agents?project=${PROJECT}`, await identityOf(STRANGER))).status).toBe(401);
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
    const stranger = await identityOf(STRANGER);
    expect((await call('GET', `/api/agents?project=${PROJECT}`, stranger)).status).toBe(401);
    expect((await call('GET', `/api/agents/${made.id}/connectors`, stranger)).status).toBe(401);
  });
});
