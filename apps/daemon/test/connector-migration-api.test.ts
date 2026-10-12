import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setBearerSessions } from '@metro-labs/http/api-http';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { sessionClaims } from '../../../packages/http/test/workos-fixture.ts';
import { bearerSessionsFor } from '../src/routes/bearer.ts';
import { localSessionApis } from '../src/routes/local-mode.ts';
import { localOwner } from '../src/agents/file-admin.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { newAgentKey, saveAgentKey } from '../src/connectors/agent-key.ts';
import { bootDaemon, type Daemon } from './http-harness.ts';
import type { MigrationApiDeps } from '../src/connectors/migration-api.ts';

const OWNER = 'org_01MIGRATIONOWNER00';
const OTHER = 'org_01OTHEROWNER00000';
const PATH = '/api/connectors/migration-preview';
const ENV = ['METRO_AGENTS_DIR', 'METRO_CONNECTORS_SYNC_ENABLED', 'METRO_CONNECTORS_LIVE_ENABLED'] as const;
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'preview-test', alg: 'RS256', use: 'sig' }] });
const networkFetch = globalThis.fetch;
let saved: Record<string, string | undefined> = {};
let dir = '';
let daemon: Daemon;
let outbound: string[] = [];
let intents: Parameters<MigrationApiDeps['run']>[] = [];
const migrationStatus = () => ({ scope: 'a'.repeat(64), owner: OWNER, agentId: 'apiagent001', enabled: true, enrolled: true, migrations: [] });
let writes = 0;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

function bearer(owner = OWNER, role = 'admin'): string {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'preview-test' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'https://api.workos.com', ...sessionClaims({ org_id: owner, role }) })).toString('base64url');
  const signed = `${head}.${body}`;
  const signature = createSign('RSA-SHA256').update(signed).sign(pair.privateKey).toString('base64url');
  return `Bearer ${signed}.${signature}`;
}

const call = (authorization?: string, method = 'GET', path = PATH) => fetch(`${daemon.base}${path}`, { method, headers: authorization === undefined ? {} : { authorization } });
const files = () => Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]));

beforeAll(async () => {
  saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  dir = mkdtempSync(join(tmpdir(), 'metro-migration-api-'));
  process.env.METRO_AGENTS_DIR = dir;
  const apis = localSessionApis({
    syncStations: () => Promise.resolve(), reloadAgents: () => Promise.resolve(), restart: () => {}, stop: () => {},
    gatherAccounts: () => Promise.resolve({ accounts: {}, unavailable: [] }), capabilities: () => ({}), prepareAccount: () => Promise.reject(new Error('unused')),
  });
  daemon = await bootDaemon({ ...apis, connectorMigrationApi: { status: migrationStatus, run: (...args) => { intents.push(args); return Promise.resolve(migrationStatus()); } } }, { monitor: true });
});

beforeEach(() => {
  for (const file of readdirSync(dir)) rmSync(join(dir, file), { force: true });
  writeFileSync(join(dir, '.owner'), OWNER);
  delete process.env.METRO_CONNECTORS_SYNC_ENABLED;
  delete process.env.METRO_CONNECTORS_LIVE_ENABLED;
  outbound = [];
  intents = [];
  writes = 0;
  const keys = new SigningKeys('https://must-not-request.example.com/jwks', { read: () => jwks, write: () => { writes += 1; } });
  setBearerSessions(bearerSessionsFor(() => localOwner(dir), keys));
  setKeyMap([{ key: 'local-agent-key', agentId: 'localagent1' }]);
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(`${daemon.base}/`)) return networkFetch(input, init);
    outbound.push(url);
    return Promise.reject(new Error('preview must not make remote requests'));
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
  setBearerSessions(null);
  setKeyMap([]);
});

afterAll(async () => {
  await daemon.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

test('real local API exposes the disabled preview only to its owner admin', async () => {
  writeFileSync(join(dir, 'connectors.json'), '{malformed connector-secret');
  writeFileSync(join(dir, 'agent-key.json'), '{malformed key-secret');
  const before = files();
  expect((await call()).status).toBe(401);
  expect((await call('Bearer not.a.token')).status).toBe(401);
  expect((await call('Bearer local-agent-key')).status).toBe(401);
  expect((await call(bearer(OWNER, 'member'))).status).toBe(403);
  const wrong = await call(bearer(OTHER));
  expect(wrong.status).toBe(403);
  expect(await wrong.json()).toEqual({ error: 'this machine belongs to another organization' });
  const admin = await call(bearer());
  expect(admin.status).toBe(200);
  expect(await admin.json()).toEqual({ migrationSupported: true, oauthResourceSupported: true, enabled: false, enrolled: false, agentId: null, owner: OWNER, liveEnabled: false, connectors: [] });
  expect(admin.headers.get('cache-control')).toBe('no-store');
  expect(files()).toEqual(before);
  expect(outbound).toEqual([]);
  expect(writes).toBe(0);
});

test('enabled preview remains admin-only, reads current enrollment, and returns no credentials or full URLs', async () => {
  process.env.METRO_CONNECTORS_SYNC_ENABLED = 'true';
  saveAgentKey(newAgentKey(), { organization: OWNER, server: 'apiagent001', at: '' }, dir);
  writeFileSync(join(dir, 'connectors.json'), JSON.stringify({ version: 1, connectors: [{ id: 'conn0000001', name: 'Example', url: 'https://mcp.example.com/private-path?key=query-secret', config: { auth: { kind: 'header', name: 'Authorization', value: 'Bearer header-secret' }, policy: { read: 'ask', write: 'deny', tools: { list: 'allow' } } } }] }));
  const before = files();
  expect((await call(bearer(OWNER, 'member'))).status).toBe(403);
  expect((await call(bearer(OTHER))).status).toBe(403);
  const response = await call(bearer());
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ migrationSupported: true, oauthResourceSupported: true, enabled: true, enrolled: true, agentId: 'apiagent001', owner: OWNER, liveEnabled: false, connectors: [{ id: 'conn0000001', name: 'Example', auth: 'header', origin: 'https://mcp.example.com', policy: { read: 'ask', write: 'deny', tools: { list: 'allow' } }, policySupported: true, issues: [] }] });
  for (const value of ['header-secret', 'query-secret', 'private-path', 'Authorization', 'signing', 'sealing', 'keyId']) expect(text).not.toContain(value);
  expect(files()).toEqual(before);
  expect(outbound).toEqual([]);
  expect(writes).toBe(0);
});

test('preview never enrolls automatically and an owner move invalidates its enrollment metadata', async () => {
  process.env.METRO_CONNECTORS_SYNC_ENABLED = 'true';
  expect(await (await call(bearer())).json()).toMatchObject({ enabled: true, enrolled: false, agentId: null, connectors: [] });
  expect(readdirSync(dir)).toEqual(['.owner']);
  saveAgentKey(newAgentKey(), { organization: OWNER, server: 'apiagent001', at: '' }, dir);
  writeFileSync(join(dir, '.owner'), OTHER);
  const before = files();
  expect((await call(bearer())).status).toBe(403);
  const moved = await call(bearer(OTHER));
  expect(moved.status).toBe(200);
  expect(await moved.json()).toMatchObject({ owner: OTHER, enrolled: false, agentId: null });
  expect(files()).toEqual(before);
  expect(outbound).toEqual([]);
});

test('malformed source errors are generic and read-only and invalid rows remain visible', async () => {
  process.env.METRO_CONNECTORS_SYNC_ENABLED = 'true';
  for (const text of ['{raw-secret https://private.example/path?secret', '{"version":1,"connectors":null}', 'null']) {
    writeFileSync(join(dir, 'connectors.json'), text);
    const before = files();
    const response = await call(bearer());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Local connector configuration cannot be previewed. Restore its file or permissions first.' });
    expect(files()).toEqual(before);
  }
  writeFileSync(join(dir, 'connectors.json'), JSON.stringify({ version: 1, connectors: [{ id: 'conn0000001', name: 'Broken', url: 'http://127.0.0.1/private-path?secret', config: { auth: { kind: 'oauth', accessToken: 'oauth-secret' } } }] }));
  const before = files();
  expect(await (await call(bearer())).json()).toMatchObject({ connectors: [{ id: 'conn0000001', auth: 'oauth', origin: null, issues: ['unsupported_url', 'oauth_sign_in'] }] });
  expect(files()).toEqual(before);
  expect(outbound).toEqual([]);
});

test('preview is GET-only and is mounted before the monitor catch-all', async () => {
  const before = files();
  expect((await call(undefined, 'OPTIONS')).status).toBe(204);
  for (const method of ['POST', 'PUT', 'DELETE']) expect((await call(bearer(), method)).status).toBe(405);
  expect((await call(bearer(), 'GET', `${PATH}/extra`)).status).toBe(404);
  expect((await call(bearer(), 'GET', `${PATH}?project=ignored`)).status).toBe(200);
  expect((await call(bearer(), 'GET', '/api/tail')).status).toBe(401);
  expect(files()).toEqual(before);
  expect(outbound).toEqual([]);
});


test('migration writes whitelist an independently supplied public resource without accepting source credentials', async () => {
  const post = (input: unknown, authorization = bearer()) => fetch(`${daemon.base}/api/connectors/migrations`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const input = { scope: 'a'.repeat(64), sourceId: 'conn0000001', operationId: null, action: 'prepare' };
  const resource = 'https://mcp.example.com/workspaces/public';
  expect((await post({ ...input, oauthResource: resource }, bearer(OWNER, 'member'))).status).toBe(403);
  expect((await post({ ...input, oauthResource: resource }, bearer(OTHER))).status).toBe(403);
  expect(intents).toHaveLength(0);
  expect((await post({ ...input, oauthResource: resource })).status).toBe(200);
  expect(intents).toEqual([['conn0000001', 'prepare', input.scope, null, null, resource]]);
  expect((await post(input)).status).toBe(200);
  expect(intents.at(-1)?.[5]).toBeUndefined();
  for (const oauthResource of ['', null, 7, 'http://mcp.example.com/path', 'https://127.0.0.1/mcp', 'https://user:secret@mcp.example.com/mcp', 'https://mcp.example.com/mcp?secret=1', 'https://mcp.example.com/mcp#secret']) {
    const response = await post({ ...input, oauthResource });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('secret=1');
  }
  expect((await post({ ...input, oauthResource: resource, url: 'https://private.example/secret' })).status).toBe(400);
  expect(intents).toHaveLength(2);
  expect(outbound).toEqual([]);
});
