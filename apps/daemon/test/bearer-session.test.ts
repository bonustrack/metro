import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setBearerSessions } from '@metro-labs/http/api-http';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { handleSessionApiRequest } from '../src/routes/session.ts';
import { handleControlRequest } from '../src/server/control.ts';
import { handleOwnerRequest } from '../src/server/owner.ts';
import { bearerSessionsFor, jwksStore } from '../src/routes/bearer.ts';
import { localOwner, setLocalOwner } from '../src/agents/file-admin.ts';
import { fakeIssuer, sessionClaims, type FakeIssuer } from '../../../packages/http/test/workos-fixture.ts';

const ORG = 'org_01M2TNE064H99ECTG4X228Y6B6';
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
    if (handleControlRequest(req, res, { authorize: () => undefined, restart: () => undefined, stop: () => { stopped += 1; }, served: () => true })) return;
    if (handleOwnerRequest(req, res, { authorize: () => undefined, setOwner: (owner) => setLocalOwner(owner, dir) })) return;
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

const bearer = (claims: Record<string, unknown>): Record<string, string> => ({ authorization: `Bearer ${issuer.mint(sessionClaims(claims))}` });
const get = (path: string, headers: Record<string, string>): Promise<Response> => fetch(`${base}${path}`, { headers });
const post = (path: string, headers: Record<string, string>, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

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

  test('an admin moves the machine to another organization: the old token is refused from then on, a member cannot, a bad id is refused', async () => {
    setLocalOwner(ORG, dir);
    const other = 'org_01OTHERORG000000000';
    expect((await post('/api/owner', bearer({ org_id: ORG, role: 'member' }), { owner: other })).status).toBe(403);
    expect((await post('/api/owner', bearer({ org_id: ORG, role: 'admin' }), { owner: 'nope' })).status).toBe(400);
    expect((await post('/api/owner', bearer({ org_id: ORG, role: 'admin' }), { owner: ORG })).status).toBe(409);
    const moved = await post('/api/owner', bearer({ org_id: ORG, role: 'admin' }), { owner: other });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ owner: other });
    expect(localOwner(dir)).toBe(other);
    expect((await post('/api/stop', bearer({ org_id: ORG, role: 'admin' }))).status).toBe(403);
    expect((await post('/api/stop', bearer({ org_id: other, role: 'admin' }))).status).toBe(200);
    setLocalOwner(ORG, dir);
  });
});
