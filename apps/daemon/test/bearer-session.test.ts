import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setBearerSessions } from '@metro-labs/http/api-http';
import { resetIdentities } from '@metro-labs/http/identity-registry';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { handleSessionApiRequest } from '../src/routes/session.ts';
import { handleOwnerRequest } from '../src/routes/owner.ts';
import { handleControlRequest } from '../src/server/control.ts';
import { bearerSessionsFor, jwksStore } from '../src/routes/bearer.ts';
import { localOwner, setLocalOwner } from '../src/agents/file-admin.ts';
import { auth, TEST_OWNER } from './identity-helper.ts';
import { fakeIssuer, sessionClaims, type FakeIssuer } from '../../../packages/http/test/workos-fixture.ts';

const ORG = 'org_01M2TNE064H99ECTG4X228Y6B6';
const WALLET = TEST_OWNER.address.toLowerCase();
let dir = '';
let issuer: FakeIssuer;
let server: Server;
let base = '';
let stopped = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-bearer-'));
  issuer = await fakeIssuer();
  setBearerSessions(bearerSessionsFor(() => localOwner(dir), new SigningKeys(issuer.url, jwksStore(dir))));
  server = createServer((req, res) => {
    if (handleSessionApiRequest(req, res)) return;
    if (handleOwnerRequest(req, res, { owner: () => localOwner(dir), setOwner: (o) => setLocalOwner(o, dir) })) return;
    if (handleControlRequest(req, res, { authorize: () => undefined, restart: () => undefined, stop: () => { stopped += 1; }, served: () => true })) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  setBearerSessions(null);
  server.close();
  await issuer.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetIdentities();
});

const bearer = (claims: Record<string, unknown>): Record<string, string> => ({ authorization: `Bearer ${issuer.mint(sessionClaims(claims))}` });
const get = (path: string, headers: Record<string, string>): Promise<Response> => fetch(`${base}${path}`, { headers });
const post = (path: string, headers: Record<string, string>, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('a box owned by an organization', () => {
  test('a member of the organization opens the session with the role; another organization is refused by name; no organization is 403 too', async () => {
    setLocalOwner(ORG, dir);
    const admin = await get('/api/session', bearer({ org_id: ORG, role: 'admin' }));
    expect(await admin.json()).toEqual({ subject: ORG, role: 'admin' });
    const member = await get('/api/session', bearer({ org_id: ORG, role: 'member' }));
    expect(await member.json()).toEqual({ subject: ORG, role: 'member' });
    const other = await get('/api/session', bearer({ org_id: 'org_01SOMEONEELSE00', role: 'admin' }));
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: string }).error).toContain('another organization');
    expect((await get('/api/session', bearer({ org_id: undefined, role: undefined }))).status).toBe(403);
    expect((await get('/api/session', { authorization: 'Bearer not.a.real.token' })).status).toBe(401);
    expect((await get('/api/session', {})).status).toBe(401);
    expect(existsSync(join(dir, '.jwks'))).toBe(true);
    expect(readFileSync(join(dir, '.jwks'), 'utf8')).toContain('"keys"');
  });

  test('stop needs the admin role: a member is 403, an admin goes through', async () => {
    setLocalOwner(ORG, dir);
    const refused = await post('/api/stop', bearer({ org_id: ORG, role: 'member' }));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toContain('admin role');
    const before = stopped;
    expect((await post('/api/stop', bearer({ org_id: ORG, role: 'admin' }))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 700));
    expect(stopped).toBe(before + 1);
  });

  test('a wallet-owned box is handed to an organization by that wallet only, once, and the wallet is refused after', async () => {
    setLocalOwner(WALLET, dir);
    const owner = await auth('POST', '/api/owner', WALLET);
    expect((await post('/api/owner', { authorization: owner }, { owner: 'nope' })).status).toBe(400);
    const stranger = await auth('POST', '/api/owner', '0x70997970c51812dc3a010c7d01b50e0d17dc79c9');
    expect((await post('/api/owner', { authorization: stranger }, { owner: ORG })).status).toBe(403);
    expect((await post('/api/owner', bearer({ org_id: ORG, role: 'admin' }), { owner: ORG })).status).toBe(403);
    const claimed = await post('/api/owner', { authorization: owner }, { owner: ORG });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toEqual({ owner: ORG, previous: WALLET });
    expect(localOwner(dir)).toBe(ORG);
    expect((await get('/api/session', { authorization: await auth('GET', '/api/session', TEST_OWNER) })).status).toBe(401);
    expect((await get('/api/session', bearer({ org_id: ORG, role: 'admin' }))).status).toBe(200);
    expect((await post('/api/owner', bearer({ org_id: ORG, role: 'admin' }), { owner: 'org_01ANOTHERORG000' })).status).toBe(409);
  });
});
