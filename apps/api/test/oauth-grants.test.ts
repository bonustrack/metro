import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomInt } from 'node:crypto';
import { AGENT_TOKENS_MAX, createAgentToken } from '@metro-labs/connectors/db/agent-tokens';
import { GRANT_REQUEST_MS, openGrant } from '@metro-labs/connectors/db/oauth-grants';
import { handleOauthGrantsRequest } from '../src/agents/oauth-grants-api.ts';
import { auth, testKeys, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { addRemoteAgent, PGLITE_START_MS, testDb, type TestDb } from './pglite-db.ts';

const REMOTE = 'remote00001';
const THEIRS = 'remote00002';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const NOW = Date.parse('2026-11-04T09:00:00.000Z');

let held: TestDb;
let server: Server;
let base = '';
let now = NOW;

async function call(path: string, init: { method?: string; body?: unknown; who?: string; role?: 'admin' | 'member' } = {}): Promise<Response> {
  const headers: Record<string, string> = { authorization: await auth(init.who ?? TEST_OWNER, init.role ?? 'admin') };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, { method: init.method ?? 'GET', headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
}

const grant = (): Promise<string> => openGrant(held.db, { clientId: 'mc1.test.sig', clientName: 'Claude', redirectUri: REDIRECT, codeChallenge: 'c'.repeat(43), state: 'st-1' }, now);

beforeAll(async () => {
  held = await testDb();
  const keys = await testKeys();
  server = createServer((req, res) => {
    if (!handleOauthGrantsRequest(req, res, { keys, db: () => held.db, now: () => now })) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => {
    server.listen(randomInt(10_000, 30_000), '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, PGLITE_START_MS);

beforeEach(async () => {
  now = NOW;
  await held.reset();
  await addRemoteAgent(held.db, REMOTE, TEST_OWNER, 'Laptop');
  await addRemoteAgent(held.db, THEIRS, TEST_STRANGER, 'Theirs');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await held.close();
});

describe('reading a grant', () => {
  test('a signed-in member sees the app and where it returns, never the code or state', async () => {
    const id = await grant();
    const res = await call(`/api/oauth/grants/${id}`, { role: 'member' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grant: Record<string, unknown> };
    expect(body.grant).toEqual({ id, client: 'Claude', returnTo: 'claude.ai', expiresAt: NOW + GRANT_REQUEST_MS });
  });

  test('an expired or unknown grant is 404, and no session is 401', async () => {
    const id = await grant();
    now += GRANT_REQUEST_MS;
    expect((await call(`/api/oauth/grants/${id}`)).status).toBe(404);
    expect((await call('/api/oauth/grants/nope')).status).toBe(404);
    expect((await fetch(`${base}/api/oauth/grants/${id}`)).status).toBe(401);
  });
});

describe('answering a grant', () => {
  test('an admin allows it for one of the organization agents and gets the return address with a code', async () => {
    const id = await grant();
    const res = await call(`/api/oauth/grants/${id}`, { method: 'POST', body: { decision: 'allow', agent: REMOTE } });
    expect(res.status).toBe(200);
    const back = new URL(((await res.json()) as { redirect: string }).redirect);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('code')?.startsWith('mcc_')).toBe(true);
    expect(back.searchParams.get('state')).toBe('st-1');
    expect((await call(`/api/oauth/grants/${id}`, { method: 'POST', body: { decision: 'allow', agent: REMOTE } })).status).toBe(404);
  });

  test('a member cannot allow, another organization agent is unknown, and a full agent is refused', async () => {
    const id = await grant();
    expect((await call(`/api/oauth/grants/${id}`, { method: 'POST', role: 'member', body: { decision: 'allow', agent: REMOTE } })).status).toBe(403);
    expect((await call(`/api/oauth/grants/${id}`, { method: 'POST', body: { decision: 'allow', agent: THEIRS } })).status).toBe(404);
    for (let i = 0; i < AGENT_TOKENS_MAX; i += 1) await createAgentToken(held.db, { owner: TEST_OWNER, agent: REMOTE, label: `key ${String(i)}`, createdBy: 'user_01TEST', now });
    expect((await call(`/api/oauth/grants/${id}`, { method: 'POST', body: { decision: 'allow', agent: REMOTE } })).status).toBe(409);
    expect((await call(`/api/oauth/grants/${id}`)).status).toBe(200);
  });

  test('anyone signed in may decline, which sends access_denied back and closes the grant', async () => {
    const id = await grant();
    const res = await call(`/api/oauth/grants/${id}`, { method: 'POST', role: 'member', body: { decision: 'deny' } });
    const back = new URL(((await res.json()) as { redirect: string }).redirect);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect((await call(`/api/oauth/grants/${id}`)).status).toBe(404);
  });
});
