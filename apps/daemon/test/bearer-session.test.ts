import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setBearerSessions } from '@metro-labs/http/api-http';
import { METRO_ISSUER } from '@metro-labs/http/workos-token';
import { handleSessionApiRequest } from '../src/routes/session.ts';
import { handleControlRequest } from '../src/server/control.ts';
import { handleOwnerRequest } from '../src/server/owner.ts';
import { handleClaudeRequest } from '../src/claude/api.ts';
import { bearerSessionsFor, boxSigningKeys } from '../src/routes/bearer.ts';
import { localOwner, setLocalOwner } from '../src/agents/file-admin.ts';
import { fakeIssuer, sessionClaims, type FakeIssuer } from '../../../packages/http/test/workos-fixture.ts';

const ORG = 'org_01M2TNE064H99ECTG4X228Y6B6';
let dir = '';
let issuer: FakeIssuer;
let metro: FakeIssuer;
let server: Server;
let base = '';
let stopped = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-bearer-'));
  issuer = await fakeIssuer();
  metro = await fakeIssuer(METRO_ISSUER);
  setBearerSessions(bearerSessionsFor(() => localOwner(dir), boxSigningKeys(dir, envOf())));
  server = createServer((req, res) => {
    if (handleSessionApiRequest(req, res)) return;
    if (handleControlRequest(req, res, { authorize: () => undefined, restart: () => undefined, stop: () => { stopped += 1; }, served: () => true })) return;
    if (handleClaudeRequest(req, res, { authorize: () => undefined, dir: () => dir })) return;
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
  await metro.close();
  rmSync(dir, { recursive: true, force: true });
});

const envOf = (metroBase = metro.base): NodeJS.ProcessEnv => ({ WORKOS_API_BASE: issuer.base, WORKOS_CLIENT_ID: 'client_test', METRO_AUTH_BASE: metroBase });
const bearer = (claims: Record<string, unknown>): Record<string, string> => ({ authorization: `Bearer ${issuer.mint(sessionClaims(claims))}` });
const metroBearer = (claims: Record<string, unknown>): Record<string, string> => ({ authorization: `Bearer ${metro.mint(sessionClaims(claims))}` });
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

  test('a session carries the WorkOS user, its session and the role, and no user id is singled out', async () => {
    setLocalOwner(ORG, dir);
    const sessions = bearerSessionsFor(() => localOwner(dir), boxSigningKeys(dir, envOf()));
    const as = (claims: Record<string, unknown>): Promise<unknown> => sessions({ headers: bearer(claims) } as unknown as IncomingMessage);
    expect(await as({ org_id: ORG, role: 'member', sub: 'user_01M2TN3K6NRVX675M617GR4WVE' })).toEqual({ subject: ORG, userId: 'user_01M2TN3K6NRVX675M617GR4WVE', sessionId: 'session_01XYZ', role: 'member' });
    expect(await as({ org_id: ORG, role: 'admin', sub: 'user_01SOMEADMIN0000000000000' })).toEqual({ subject: ORG, userId: 'user_01SOMEADMIN0000000000000', sessionId: 'session_01XYZ', role: 'admin' });
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

  test('the Claude session and setup writes need the admin role; reading them does not; there is no version or login route', async () => {
    setLocalOwner(ORG, dir);
    for (const path of ['/api/claude/session', '/api/claude/setup']) {
      expect((await post(path, bearer({ org_id: ORG, role: 'member' }), {})).status).toBe(403);
    }
    expect((await post('/api/claude/setup', bearer({ org_id: ORG, role: 'admin' }), {})).status).toBe(400);
    expect((await get('/api/claude/version', bearer({ org_id: ORG, role: 'admin' }))).status).toBe(404);
    expect((await post('/api/claude/version', bearer({ org_id: ORG, role: 'admin' }), {})).status).toBe(405);
    expect((await post('/api/claude/login', bearer({ org_id: ORG, role: 'admin' }), {})).status).toBe(405);
    expect((await get('/api/claude/login/abc', bearer({ org_id: ORG, role: 'admin' }))).status).toBe(404);
    expect((await get('/api/claude/skills', bearer({ org_id: ORG, role: 'member' }))).status).toBe(200);
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

describe('a Metro sign-in token on a box', () => {
  const waitFor = async (path: string): Promise<boolean> => {
    for (let i = 0; i < 50 && !existsSync(path); i += 1) await new Promise((r) => setTimeout(r, 20));
    return existsSync(path);
  };

  test('boot fetches the Metro key set into its own cache, readable by Metro only', async () => {
    expect(await waitFor(join(dir, '.jwks-metro'))).toBe(true);
    expect(readFileSync(join(dir, '.jwks-metro'), 'utf8')).toContain('"keys"');
    expect(statSync(join(dir, '.jwks-metro')).mode & 0o777).toBe(0o600);
  });

  test('a Metro token of the owner organization opens the session with its role, like a WorkOS one', async () => {
    setLocalOwner(ORG, dir);
    const admin = await get('/api/session', metroBearer({ org_id: ORG, role: 'admin' }));
    expect(admin.status).toBe(200);
    expect(await admin.json()).toEqual({ subject: ORG, role: 'admin' });
    const member = await get('/api/session', metroBearer({ org_id: ORG, role: 'member' }));
    expect(await member.json()).toEqual({ subject: ORG, role: 'member' });
    expect((await post('/api/stop', metroBearer({ org_id: ORG, role: 'member' }))).status).toBe(403);
    expect((await get('/api/session', bearer({ org_id: ORG, role: 'admin' }))).status).toBe(200);
  });

  test('a Metro token of another organization, or of none, is 403 with the same sentence', async () => {
    setLocalOwner(ORG, dir);
    const other = await get('/api/session', metroBearer({ org_id: 'org_01SOMEONEELSE00', role: 'admin' }));
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: string }).error).toContain('another organization');
    expect((await get('/api/session', metroBearer({ org_id: undefined, role: undefined }))).status).toBe(403);
  });

  test('a Metro token signed with a WorkOS key, or living over an hour, is 401', async () => {
    setLocalOwner(ORG, dir);
    const now = Math.floor(Date.now() / 1000);
    const crossed = { authorization: `Bearer ${issuer.mint(sessionClaims({ org_id: ORG, iss: METRO_ISSUER }), { kid: metro.kid })}` };
    expect((await get('/api/session', crossed)).status).toBe(401);
    expect((await get('/api/session', metroBearer({ org_id: ORG, iat: now, exp: now + 7200 }))).status).toBe(401);
  });

  test('a box whose Metro key set cannot be reached at boot still starts and still takes WorkOS tokens', async () => {
    const quiet = mkdtempSync(join(tmpdir(), 'metro-bearer-down-'));
    try {
      setLocalOwner(ORG, quiet);
      const sessions = bearerSessionsFor(() => localOwner(quiet), boxSigningKeys(quiet, envOf('http://127.0.0.1:1')));
      const as = (headers: Record<string, string>): Promise<unknown> => sessions({ headers } as unknown as IncomingMessage);
      expect(await as(bearer({ org_id: ORG, role: 'admin' }))).toMatchObject({ subject: ORG, role: 'admin' });
      expect(await as(metroBearer({ org_id: ORG, role: 'admin' }))).toBeNull();
      expect(existsSync(join(quiet, '.jwks-metro'))).toBe(false);
    } finally {
      rmSync(quiet, { recursive: true, force: true });
    }
  });
});
