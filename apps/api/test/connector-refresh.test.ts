import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { refreshConnector, type RefreshRequest } from '@metro-labs/connectors/refresh';
import { credentialRevision } from '@metro-labs/connectors/revision';
import { openConnectorSecret, sealConnectorSecret } from '@metro-labs/connectors/model';
import { connectorDeliveryStore } from '@metro-labs/connectors/db/connector-delivery';
import { connectors } from '../src/db/schema.js';
import { TEST_STRANGER } from './identity-helper.js';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.js';
import { CONN, MASTER, assignConnector, enrollAgent, newEnrolledAgent, oauthSecret, opaque, seedConnector, type EnrolledAgent } from './connector-agent-fixture.js';

let held: TestDb;
let agent: EnrolledAgent;

beforeAll(async () => { held = await testDb(); }, PGLITE_START_MS);
beforeEach(async () => {
  await held.reset();
  agent = newEnrolledAgent();
  await enrollAgent(held.db, agent);
}, PGLITE_STEP_MS);
afterAll(async () => { await held.close(); });

const refresh = (fetch: FetchLike, forced?: RefreshRequest, connector = CONN) =>
  refreshConnector({ key: MASTER, store: connectorDeliveryStore(() => held.db), fetch, now: Date.now }, agent.row, connector, forced);

function counted(answer: () => Promise<Response>): { fetch: FetchLike; calls: () => number } {
  let calls = 0;
  return { fetch: () => { calls += 1; return answer(); }, calls: () => calls };
}

const rotated = () => Promise.resolve(Response.json({ access_token: 'ACCESS_NEW', refresh_token: 'REFRESH_ROTATED', expires_in: 3600 }));

async function secretNow(id = CONN) {
  const row = (await held.db.select().from(connectors).where(eq(connectors.id, id)))[0];
  if (row === undefined) throw new Error('missing row');
  const secret = openConnectorSecret(MASTER, row);
  if (secret?.kind !== 'oauth') throw new Error('not OAuth');
  return { row, secret };
}

describe('central encrypted OAuth refresh', () => {
  test('an expired access token refreshes with scoped resource and client through the injected fetch, and rotates refresh tokens', async () => {
    const original = await seedConnector(held.db, oauthSecret());
    await assignConnector(held.db, agent);
    let calls = 0;
    const failed = await refresh((url, init) => {
      calls += 1;
      expect(url).toBe('https://vendor.example/token');
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ grant_type: 'refresh_token', refresh_token: 'REFRESH_OLD', resource: 'https://vendor.example/mcp', scope: 'read write', client_id: 'CLIENT_ID', client_secret: 'CLIENT_SECRET' });
      return Promise.resolve(Response.json({ access_token: 'ACCESS_NEW', refresh_token: 'REFRESH_ROTATED', expires_in: 3600 }));
    });
    expect(failed).toEqual(new Map());
    expect(calls).toBe(1);
    const current = await secretNow();
    expect(current.secret.tokens?.accessToken).toBe('ACCESS_NEW');
    expect(current.secret.tokens?.refreshToken).toBe('REFRESH_ROTATED');
    expect(current.secret.tokens?.resource).toBe('https://vendor.example/mcp');
    expect(current.secret.targetUrl).toBe('https://vendor.example/mcp?key=URL_SECRET');
    expect(current.row.secret).not.toContain('REFRESH_ROTATED');
    expect(current.row.secret).not.toBe(original.secret);
    expect(credentialRevision(MASTER, current.row)).not.toBe(credentialRevision(MASTER, original));
  });

  test('only a connector assigned to this agent in its own organization is refreshed', async () => {
    const other = newEnrolledAgent('agent000002');
    await enrollAgent(held.db, other);
    await seedConnector(held.db, oauthSecret());
    await seedConnector(held.db, oauthSecret(), { id: 'conn0000002', name: 'Not assigned' });
    await seedConnector(held.db, oauthSecret(), { id: 'conn0000003', name: 'Other organization', owner: TEST_STRANGER });
    await assignConnector(held.db, agent);
    await assignConnector(held.db, other, 'conn0000002');
    await assignConnector(held.db, agent, 'conn0000003');
    expect((await connectorDeliveryStore(() => held.db).assigned(agent.row)).map((row) => row.connector.id)).toEqual([CONN]);
    const provider = counted(rotated);
    for (const id of [CONN, 'conn0000002', 'conn0000003']) await refresh(provider.fetch, undefined, id);
    expect(provider.calls()).toBe(1);
    expect((await secretNow()).secret.tokens?.refreshToken).toBe('REFRESH_ROTATED');
    expect((await secretNow('conn0000002')).secret.tokens?.refreshToken).toBe('REFRESH_OLD');
  });

  test.each([false, true])('legacy tokens without a public grant resource require fresh sign-in, expired=%s', async (expired) => {
    const secret = oauthSecret(expired ? Date.now() - 1 : Date.now() + 3600_000);
    if (secret.tokens === undefined) throw new Error('missing fixture');
    delete secret.tokens.resource;
    await seedConnector(held.db, secret);
    await assignConnector(held.db, agent);
    const provider = counted(() => { throw new Error('Legacy resource must not refresh'); });
    expect(await refresh(provider.fetch)).toEqual(new Map());
    const current = await secretNow();
    expect(current.secret.tokens).toBeUndefined();
    expect(current.secret.oauthResource).toBe(secret.oauthResource);
    expect(current.secret.targetUrl).toBe(secret.targetUrl);
    expect(current.row.detail).toBeNull();
    expect(provider.calls()).toBe(0);
  });

  test.each(['stale revision', 'allowed tool exception'])('resource-less grants cannot bypass reauthentication through %s', async (mode) => {
    const secret = oauthSecret(Date.now() + 3600_000);
    if (secret.tokens === undefined) throw new Error('missing fixture');
    delete secret.tokens.resource;
    const policy = mode === 'allowed tool exception' ? '{"read":"deny","write":"deny","tools":{"read_item":"allow"}}' : null;
    const row = await seedConnector(held.db, secret, { policy });
    await assignConnector(held.db, agent);
    const provider = counted(() => { throw new Error('No legacy refresh may run'); });
    await refresh(provider.fetch, mode === 'stale revision' ? { connectorId: CONN, revision: opaque() } : undefined);
    expect(provider.calls()).toBe(0);
    if (mode === 'stale revision') expect((await secretNow()).row.secret).toBe(row.secret);
    else expect((await secretNow()).secret.tokens).toBeUndefined();
  });

  test.each([
    { name: 'named allow', policy: '{"read":"deny","write":"deny","tools":{"read_item":"allow"}}', refreshed: true },
    { name: 'named approval', policy: '{"read":"deny","write":"deny","tools":{"read_item":"ask"}}', refreshed: true },
    { name: 'all denied', policy: '{"read":"deny","write":"deny"}', refreshed: false },
    { name: 'invalid', policy: '{"read":"invalid"}', refreshed: false },
  ])('$name policy refreshes only potentially callable credentials', async ({ policy, refreshed }) => {
    const original = await seedConnector(held.db, oauthSecret(), { policy });
    await assignConnector(held.db, agent);
    const provider = counted(rotated);
    expect(await refresh(provider.fetch)).toEqual(new Map());
    expect(provider.calls()).toBe(refreshed ? 1 : 0);
    const current = await secretNow();
    if (refreshed) expect(current.secret.tokens?.refreshToken).toBe('REFRESH_ROTATED');
    else expect(current.row.secret).toBe(original.secret);
  });

  test('an omitted refresh token is preserved, not erased by replacement access tokens', async () => {
    await seedConnector(held.db, oauthSecret());
    await assignConnector(held.db, agent);
    await refresh(() => Promise.resolve(Response.json({ access_token: 'ACCESS_NEW', expires_in: 3600 })));
    const current = await secretNow();
    expect(current.secret.tokens?.accessToken).toBe('ACCESS_NEW');
    expect(current.secret.tokens?.refreshToken).toBe('REFRESH_OLD');
  });

  test('forced refresh is conditional on the prior opaque revision, stale retries do not rotate twice', async () => {
    const row = await seedConnector(held.db, oauthSecret(Date.now() + 3600_000));
    await assignConnector(held.db, agent);
    const provider = counted(rotated);
    const forced = { connectorId: CONN, revision: credentialRevision(MASTER, row) };
    await refresh(provider.fetch, { ...forced, revision: opaque() });
    expect(provider.calls()).toBe(0);
    await refresh(provider.fetch, forced);
    await refresh(provider.fetch, forced);
    expect(provider.calls()).toBe(1);
    expect((await secretNow()).secret.tokens?.refreshToken).toBe('REFRESH_ROTATED');
  });

  test('a stale forced refresh does not override a newer sign-in generation', async () => {
    const row = await seedConnector(held.db, oauthSecret(Date.now() + 3600_000));
    await assignConnector(held.db, agent);
    const before = credentialRevision(MASTER, row);
    await held.db.update(connectors).set({ authGeneration: 'newer000001' }).where(eq(connectors.id, CONN));
    const provider = counted(() => Promise.resolve(Response.json({ access_token: 'wrong' })));
    await refresh(provider.fetch, { connectorId: CONN, revision: before });
    expect(provider.calls()).toBe(0);
    expect((await secretNow()).secret.tokens?.accessToken).toBe('ACCESS_OLD');
  });

  test('only an OAuth invalid_grant permanently disconnects, retaining client discovery without tokens', async () => {
    await seedConnector(held.db, oauthSecret());
    await assignConnector(held.db, agent);
    expect(await refresh(() => Promise.resolve(Response.json({ error: 'invalid_grant', error_description: 'SECRET_ERROR_WITH_TOKEN' }, { status: 400 })))).toEqual(new Map());
    const current = await secretNow();
    expect(current.secret.tokens).toBeUndefined();
    expect(current.secret.client.clientSecret).toBe('CLIENT_SECRET');
    expect(current.row.detail).toBeNull();
  });

  test('transient HTTP, network and malformed token answers preserve all credentials and report the refused revision', async () => {
    const row = await seedConnector(held.db, oauthSecret());
    await assignConnector(held.db, agent);
    const responses: FetchLike[] = [
      () => Promise.reject(new Error('SECRET_URL_AND_TOKEN')),
      () => Promise.resolve(Response.json({ error: 'invalid_grant' }, { status: 503 })),
      () => Promise.resolve(Response.json({ error: 'temporarily_unavailable' }, { status: 400 })),
      () => Promise.resolve(new Response('not json', { status: 200 })),
      () => Promise.resolve(Response.json({ access_token: '' })),
      () => Promise.resolve(Response.json({ access_token: 'good', refresh_token: '' })),
      () => Promise.resolve(Response.json({ access_token: 'good', expires_in: 'unknown' })),
      () => Promise.resolve(Response.json({ access_token: 'good', expires_in: -2 })),
      () => Promise.resolve(Response.json({ access_token: 'good', token_type: 'mac' })),
      () => Promise.resolve(Response.json({ access_token: 'bad\r\nheader' })),
    ];
    for (const fail of responses) {
      expect(await refresh(fail)).toEqual(new Map([[CONN, credentialRevision(MASTER, row)]]));
      expect((await secretNow()).row.secret).toBe(row.secret);
    }
    expect((await secretNow()).secret.tokens?.refreshToken).toBe('REFRESH_OLD');
  });

  test('a failed forced refresh with an unexpired token reports the refused revision and keeps the credential', async () => {
    const row = await seedConnector(held.db, oauthSecret(Date.now() + 3600_000));
    await assignConnector(held.db, agent);
    const revision = credentialRevision(MASTER, row);
    expect(await refresh(() => Promise.reject(new Error('network')), { connectorId: CONN, revision })).toEqual(new Map([[CONN, revision]]));
    expect((await secretNow()).row.secret).toBe(row.secret);
  });

  test('malformed stored expiry is never turned into a non-expiring access token', async () => {
    const row = await seedConnector(held.db, oauthSecret());
    const secret = oauthSecret();
    const corrupted = { ...secret, tokens: { accessToken: 'ACCESS_OLD', refreshToken: 'REFRESH_OLD', expiresAt: null } };
    const sealed = sealConnectorSecret(MASTER, row, corrupted as unknown as typeof secret);
    await held.db.update(connectors).set({ secret: sealed }).where(eq(connectors.id, CONN));
    await assignConnector(held.db, agent);
    const provider = counted(rotated);
    expect(await refresh(provider.fetch)).toEqual(new Map());
    expect(provider.calls()).toBe(0);
    const current = await secretNow();
    expect(current.secret.tokens).toBeUndefined();
    expect(current.row.secret).toBe(sealed);
  });
});
