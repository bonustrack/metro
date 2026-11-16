import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountId } from '../src/db/account-ids.ts';
import { addMember } from '../src/db/memberships.ts';
import { memberships } from '../src/db/schema.ts';
import type { ServerEntry } from '../src/server-types.ts';
import { ADMIN, claimsOf, harness, NOW, ORG, OTHER_ORG, type Harness, type TokenBody } from './metro-accounts-fixture.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS } from './pglite-db.ts';
import { pngDataUrl } from './png-fixture.ts';
import { fakeIssuer, sessionClaims, type FakeIssuer } from '../../../packages/http/test/token-fixture.ts';

let h: Harness;
let foreign: FakeIssuer;
let stranger: FakeIssuer;

beforeAll(async () => {
  h = await harness();
  foreign = await fakeIssuer('https://issuer.example');
  stranger = await fakeIssuer();
}, PGLITE_START_MS);

beforeEach(async () => {
  await h.seed();
  h.clock.now = NOW;
  delete h.deps.agentsOf;
}, PGLITE_STEP_MS);

afterAll(async () => {
  await Promise.all([h.close(), foreign.close(), stranger.close()]);
});

const body = async (res: Response): Promise<TokenBody> => {
  expect(res.status).toBe(200);
  return (await res.json()) as TokenBody;
};

const agent = (id: string, name: string): ServerEntry => ({ id, kind: 'box', host: `${name.toLowerCase()}.tail1234.ts.net`, name, addedAt: '2026-11-16T09:00:00.000Z', instanceId: 'i-secret', launchedAt: null, avatar: null, slug: name.toLowerCase(), awsConnection: null });

describe('the account of the person signed in', () => {
  test('a PNG picture is kept, null removes it, and a name shows on the next tokens; an SVG, an empty body or no token is refused', async () => {
    await addMember(h.held.db, { organization: ORG, email: 'ana@example.com', role: 'member', by: ADMIN, now: NOW });
    const first = await h.tokens('google', claimsOf('google'));
    const put = (change: unknown, bearer: string | undefined = first.accessToken): Promise<Response> => h.json('PUT', '/api/auth/account', change, bearer);
    const picture = pngDataUrl(64, 64);
    expect((await put({ avatar: picture })).status).toBe(200);
    expect((await put({ name: '  Ana   Lima-Dias ' })).status).toBe(200);
    expect((await put({ avatar: 'data:image/svg+xml;base64,PHN2Zz4=' })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await h.json('PUT', '/api/auth/account', { name: 'x' })).status).toBe(401);
    const next = await body(await h.json('POST', '/api/auth/refresh', { refreshToken: first.refreshToken, organization: ORG }));
    expect(next.user).toMatchObject({ id: first.user.id, name: 'Ana Lima-Dias', picture });
    expect((await put({ avatar: null }, next.accessToken)).status).toBe(200);
    const after = await body(await h.json('POST', '/api/auth/refresh', { refreshToken: next.refreshToken, organization: ORG }));
    expect(after.user.picture).toBe('https://lh3.example/ana.png');
  });
});

describe('the organization list', () => {
  test('each organization carries its own agents with only id, host, name, slug and avatar, and nothing of an organization the person is not in', async () => {
    const asked: string[] = [];
    const rows: Record<string, ServerEntry[]> = { [ORG]: [agent('agentstage1', 'Andy')], [OTHER_ORG]: [agent('agentother1', 'Bea')] };
    h.deps.agentsOf = (organization) => {
      asked.push(organization);
      return Promise.resolve(rows[organization] ?? []);
    };
    const list = async (): Promise<{ id: string; agents?: unknown }[]> => {
      const res = await h.json('GET', '/api/auth/organizations', undefined, h.bearer({ sub: ADMIN, org_id: ORG, role: 'admin' }));
      expect(res.status).toBe(200);
      return ((await res.json()) as { organizations: { id: string; agents?: unknown }[] }).organizations;
    };
    expect((await list()).map((o) => [o.id, o.agents])).toEqual([[ORG, [{ id: 'agentstage1', host: 'andy.tail1234.ts.net', name: 'Andy', slug: 'andy', avatar: null }]]]);
    expect(asked).toEqual([ORG]);
    await h.held.db.insert(memberships).values({ id: accountId('om', NOW), organization: OTHER_ORG, userId: ADMIN, role: 'member', createdAt: NOW, updatedAt: NOW });
    const both = await list();
    expect(Object.fromEntries(both.map((o) => [o.id, o.agents]))).toEqual({
      [ORG]: [{ id: 'agentstage1', host: 'andy.tail1234.ts.net', name: 'Andy', slug: 'andy', avatar: null }],
      [OTHER_ORG]: [{ id: 'agentother1', host: 'bea.tail1234.ts.net', name: 'Bea', slug: 'bea', avatar: null }],
    });
    expect(JSON.stringify(both)).not.toContain('i-secret');
    expect((await h.json('GET', '/api/auth/organizations')).status).toBe(401);
  });
});

describe('a signed-in route', () => {
  test('/api/auth/me refuses no token, a forged one, another issuer\'s and a key Metro does not hold; a wrong method is 405 and preflight passes', async () => {
    const me = (bearer?: string, method = 'GET'): Promise<Response> => h.json(method, '/api/auth/me', undefined, bearer);
    expect((await me(h.bearer({ sub: ADMIN, org_id: ORG, role: 'admin' }))).status).toBe(200);
    expect((await me()).status).toBe(401);
    expect((await me('a.b.c')).status).toBe(401);
    expect((await me(foreign.mint(sessionClaims({ sub: ADMIN, org_id: ORG })))).status).toBe(401);
    expect((await me(stranger.mint(sessionClaims({ sub: ADMIN, org_id: ORG })))).status).toBe(401);
    expect((await me(h.bearer({ sub: ADMIN, org_id: ORG, role: 'admin' }), 'DELETE')).status).toBe(405);
    expect((await h.json('GET', '/api/auth/nothing')).status).toBe(404);
    expect((await fetch(`${h.base}/api/auth/me`, { method: 'OPTIONS' })).status).toBe(204);
  });
});
