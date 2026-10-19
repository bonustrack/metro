import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { handleMembersApiRequest } from '../src/auth/members.ts';
import { handleAuthApiRequest } from '../src/auth/routes.ts';
import { readWorkosConfig } from '../src/auth/workos.ts';
import { organizationStore } from '../src/db/organizations.ts';
import { organizations } from '../src/db/schema.ts';
import { fakeWorkos, type FakeWorkos } from './workos-fake.ts';
import { memoryUsers } from './users-fake.ts';
import { pngDataUrl } from './png-fixture.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { sessionClaims } from '../../../packages/http/test/workos-fixture.ts';

const ORG = 'org_01STAGELABS000';
const OTHER = 'org_01OTHERORG0000';
const PICTURE = pngDataUrl(128, 128);

let held: TestDb;
let workos: FakeWorkos;
let server: Server;
let base = '';

beforeAll(async () => {
  held = await testDb();
  workos = await fakeWorkos();
  workos.organizations.push(ORG, OTHER);
  const env = { WORKOS_API_KEY: 'sk_test_fake', WORKOS_CLIENT_ID: 'client_test', WORKOS_API_BASE: workos.base };
  const store = organizationStore(() => held.db);
  const deps = { config: () => readWorkosConfig(env), keys: new SigningKeys(workos.issuer.url), slugs: store, orgAvatars: store, users: memoryUsers() };
  server = createServer((req, res) => {
    if (handleMembersApiRequest(req, res, deps) || handleAuthApiRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, PGLITE_START_MS);

beforeEach(async () => {
  await held.reset();
}, PGLITE_STEP_MS);

afterAll(async () => {
  server.close();
  await workos.close();
  await held.close();
});

const admin = (): string => workos.issuer.mint(sessionClaims({ sub: 'user_01ABC', org_id: ORG, role: 'admin' }));
const member = (): string => workos.issuer.mint(sessionClaims({ sub: 'user_02BOB', org_id: ORG, role: 'member' }));

const call = (method: string, path: string, who: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

const stored = async (id = ORG): Promise<string | null | undefined> => (await held.db.select({ avatar: organizations.avatar }).from(organizations).where(eq(organizations.id, id)))[0]?.avatar;

const shown = async (who: string): Promise<{ overview: unknown; listed: Record<string, unknown> }> => {
  const overview = ((await (await call('GET', '/api/organization', who)).json()) as { avatar: unknown }).avatar;
  const rows = ((await (await call('GET', '/api/auth/organizations', who)).json()) as { organizations: { id: string; avatar: unknown }[] }).organizations;
  return { overview, listed: Object.fromEntries(rows.map((o) => [o.id, o.avatar])) };
};

describe('the picture of an organization on metro.box', () => {
  test('the migration adds an empty text column, so every organization starts with no picture', async () => {
    const column = await held.db.execute(sql`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'avatar'`);
    expect(column.rows).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
    expect(await shown(member())).toEqual({ overview: null, listed: { [ORG]: null, [OTHER]: null } });
  }, PGLITE_STEP_MS);

  test('an admin sets it, every member reads it on the organization and in the organization list, and null removes it', async () => {
    const set = await call('PUT', '/api/organization/avatar', admin(), { avatar: PICTURE });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ id: ORG, avatar: PICTURE });
    expect(await stored()).toBe(PICTURE);
    const minted = (await held.db.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, ORG)))[0]?.slug;
    expect(minted).toMatch(/^stage-labs/);
    expect(((await (await call('GET', '/api/organization', member())).json()) as { slug: string }).slug).toBe(minted ?? '');
    expect(await shown(member())).toEqual({ overview: PICTURE, listed: { [ORG]: PICTURE, [OTHER]: null } });
    const cleared = await call('PUT', '/api/organization/avatar', admin(), { avatar: null });
    expect(await cleared.json()).toEqual({ id: ORG, avatar: null });
    expect(await stored()).toBeNull();
    expect(await shown(member())).toEqual({ overview: null, listed: { [ORG]: null, [OTHER]: null } });
  }, PGLITE_STEP_MS);

  test('a member may not change it, and only a small real PNG is kept', async () => {
    await call('PUT', '/api/organization/avatar', admin(), { avatar: PICTURE });
    expect((await call('PUT', '/api/organization/avatar', member(), { avatar: pngDataUrl(8, 8) })).status).toBe(403);
    expect((await call('PUT', '/api/organization/avatar', member(), { avatar: null })).status).toBe(403);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64');
    expect((await call('PUT', '/api/organization/avatar', admin(), { avatar: `data:image/svg+xml;base64,${svg}` })).status).toBe(400);
    expect((await call('PUT', '/api/organization/avatar', admin(), { avatar: `data:image/png;base64,${svg}` })).status).toBe(400);
    expect((await call('PUT', '/api/organization/avatar', admin(), { avatar: pngDataUrl(300, 300) })).status).toBe(400);
    expect((await call('PUT', '/api/organization/avatar', admin(), {})).status).toBe(400);
    expect((await call('PUT', '/api/organization/avatar', admin(), JSON.stringify({ avatar: `data:image/png;base64,${'A'.repeat(200 * 1024)}` }))).status).toBe(413);
    expect((await call('GET', '/api/organization/avatar', admin())).status).toBe(405);
    expect((await call('PUT', '/api/organization/avatar/other', admin(), { avatar: PICTURE })).status).toBe(404);
    expect(await stored()).toBe(PICTURE);
  }, PGLITE_STEP_MS);

  test('a value in the table that is not a PNG data url is never served', async () => {
    await call('PUT', '/api/organization/avatar', admin(), { avatar: PICTURE });
    await held.db.update(organizations).set({ avatar: 'javascript:alert(1)' }).where(eq(organizations.id, ORG));
    expect(await shown(admin())).toEqual({ overview: null, listed: { [ORG]: null, [OTHER]: null } });
  }, PGLITE_STEP_MS);

  test('the store refuses an organization it has no row for', async () => {
    const store = organizationStore(() => held.db);
    let refused = false;
    await store.setAvatar('org_01NOROW00000000', PICTURE).catch(() => {
      refused = true;
    });
    expect(refused).toBe(true);
    expect(await store.avatars([])).toEqual(new Map());
  }, PGLITE_STEP_MS);
});
