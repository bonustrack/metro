import { afterEach, describe, expect, test } from 'bun:test';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { refreshConnector, type RefreshDeps } from '@metro-labs/connectors/refresh';
import { credentialRevision } from '@metro-labs/connectors/revision';
import { openConnectorSecret, type ConnectorSecret } from '@metro-labs/connectors/model';
import { connectorDeliveryStore } from '@metro-labs/connectors/db/connector-delivery';
import { orgConnectorStore, type ConnectorRow } from '@metro-labs/connectors/db/connectors';
import { OwnerTickets } from '../src/agents/tickets.js';
import { completeSignIn, type ActionDeps } from '../src/connectors/actions.js';
import type { Handoff, SignInState } from '../src/connectors/sign-in.js';
import type { Database } from '../src/db/client.js';
import { connectors } from '../src/db/schema.js';
import { assignConnector, CONN, enrollAgent, latch, MASTER, newEnrolledAgent, oauthSecret, seedConnector } from './connector-agent-fixture.js';
import { postgresFixture, TEST_DATABASE_URL } from './connector-postgres-fixture.js';
import { TEST_OWNER } from './identity-helper.js';

const TARGET = 'https://vendor.example/SECRET_PATH/tools?key=TRANSPORT_SECRET';
const TOKEN_ENDPOINT = 'https://issuer.example/token';
const SCOPE = 'original.read original.write';

type OAuthSecret = Extract<ConnectorSecret, { kind: 'oauth' }>;
let held: Awaited<ReturnType<typeof postgresFixture>> | undefined;
const pauses: ReturnType<typeof latch>[] = [];
afterEach(async () => { for (const pause of pauses.splice(0)) pause.release(); await held?.close(); held = undefined; });

function importedSecret(expiresAt: number): OAuthSecret {
  return {
    kind: 'oauth', targetUrl: TARGET,
    client: { clientId: 'original-dynamic-client', clientSecret: 'ORIGINAL_CLIENT_SECRET' },
    server: { issuer: 'https://issuer.example', authorizationEndpoint: '', tokenEndpoint: TOKEN_ENDPOINT, registrationEndpoint: null, supportsS256: true, scopes: [] },
    tokens: { accessToken: 'OLD_ACCESS_SECRET', refreshToken: 'OLD_REFRESH_SECRET', resource: TARGET, expiresAt },
    imported: { state: 'owned', tokenEndpointAuthMethod: 'client_secret_post', scope: SCOPE },
  };
}

async function setup(seeded: OAuthSecret) {
  if (TEST_DATABASE_URL === undefined) throw new Error('disposable PostgreSQL required');
  const db = held = await postgresFixture(TEST_DATABASE_URL);
  const agent = newEnrolledAgent();
  await enrollAgent(db.db1, agent);
  const row = await seedConnector(db.db1, seeded);
  await assignConnector(db.db1, agent);
  const forms: URLSearchParams[] = [];
  const control = { failure: false, hold: null as ReturnType<typeof latch> | null };
  const send: FetchLike = async (target, init) => {
    if (target !== seeded.server.tokenEndpoint) throw new Error(`unexpected fetch to ${target}`);
    forms.push(new URLSearchParams(String(init?.body)));
    await control.hold?.pause();
    if (control.failure) throw new Error('provider-lost-rotated-SECRET');
    return Response.json({ access_token: 'ROTATED_ACCESS_SECRET', refresh_token: 'ROTATED_REFRESH_SECRET', expires_in: 3600 });
  };
  const process = (pool: Database): RefreshDeps => ({ key: MASTER, store: connectorDeliveryStore(() => pool), fetch: send, now: Date.now });
  const stored = async () => {
    const current = (await db.db2.select().from(connectors))[0];
    if (current === undefined) throw new Error('connector missing');
    return { row: current, secret: openConnectorSecret(MASTER, current) };
  };
  const refresh = (deps: RefreshDeps, forced?: string) => refreshConnector(deps, agent.row, CONN, forced === undefined ? undefined : { connectorId: CONN, revision: forced });
  const hold = () => { control.hold = latch(); pauses.push(control.hold); return control.hold; };
  return { db, row, first: process(db.db1), second: process(db.db2), stored, refresh, hold, forms, control };
}

async function signIn(db: Database, row: ConnectorRow): Promise<unknown> {
  const secret = oauthSecret();
  const states = new OwnerTickets<SignInState>((value) => value.connector, { what: 'test sign-in' });
  const handoffs = new OwnerTickets<Handoff>((value) => value.connector, { what: 'test sign-in' });
  const deps: ActionDeps = {
    key: () => MASTER, store: orgConnectorStore(() => db), states, handoffs, now: Date.now, httpsOnly: true, callbackUrl: 'https://api.metro.box/api/connectors/callback',
    fetch: (url) => Promise.resolve(url === secret.server.tokenEndpoint ? Response.json({ access_token: 'SIGNIN_ACCESS', refresh_token: 'SIGNIN_REFRESH', expires_in: 3600 }) : Response.json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', serverInfo: { name: 'Signed in' } } })),
  };
  const userId = 'user_01TEST';
  const { ticket } = handoffs.mint({ owner: TEST_OWNER, connector: row.id, generation: row.authGeneration ?? '', userId, verifier: 'verifier', code: 'code', returnTo: 'https://metro.box/', resource: secret.oauthResource ?? '', configuredResource: secret.oauthResource, targetUrl: secret.targetUrl, client: secret.client, server: secret.server }, Date.now());
  return completeSignIn(deps, { owner: TEST_OWNER, session: { userId, sessionId: 'session_test', organization: TEST_OWNER, role: 'admin', expiresAt: Date.now() + 60_000 } }, { handoff: ticket });
}

describe.skipIf(TEST_DATABASE_URL === undefined)('durable imported OAuth grant refresh across PostgreSQL connections', () => {
  test('two independent processes refresh an expired imported grant exactly once and keep its binding', async () => {
    const f = await setup(importedSecret(1));
    const hold = f.hold();
    const one = f.refresh(f.first);
    await hold.reached;
    const during = await f.stored();
    expect(during.secret?.kind === 'oauth' ? during.secret.imported?.state : null).toBe('refreshing');
    const two = f.refresh(f.second);
    await f.db.waiting('two');
    expect(f.forms).toHaveLength(1);
    hold.release();
    await Promise.all([one, two]);
    expect(f.forms).toHaveLength(1);
    expect(Object.fromEntries(f.forms[0] ?? [])).toEqual({ grant_type: 'refresh_token', refresh_token: 'OLD_REFRESH_SECRET', resource: TARGET, scope: SCOPE, client_id: 'original-dynamic-client', client_secret: 'ORIGINAL_CLIENT_SECRET' });
    const { secret } = await f.stored();
    if (secret?.kind !== 'oauth') throw new Error('grant missing');
    expect(secret.tokens).toMatchObject({ accessToken: 'ROTATED_ACCESS_SECRET', refreshToken: 'ROTATED_REFRESH_SECRET', resource: TARGET });
    expect(secret.imported).toEqual({ state: 'owned', tokenEndpointAuthMethod: 'client_secret_post', scope: SCOPE });
    expect(secret.client).toEqual({ clientId: 'original-dynamic-client', clientSecret: 'ORIGINAL_CLIENT_SECRET' });
    expect(secret.server.issuer).toBe('https://issuer.example');
    const bytes = JSON.stringify(await f.db.db1.select().from(connectors));
    for (const text of ['OLD_ACCESS_SECRET', 'OLD_REFRESH_SECRET', 'ROTATED_ACCESS_SECRET', 'ROTATED_REFRESH_SECRET', 'ORIGINAL_CLIENT_SECRET', 'SECRET_PATH', 'TRANSPORT_SECRET']) expect(bytes).not.toContain(text);
  }, 20_000);

  test('a live imported grant needs no refresh', async () => {
    const f = await setup(importedSecret(Date.now() + 3600_000));
    await f.refresh(f.first);
    await f.refresh(f.second);
    expect(f.forms).toHaveLength(0);
    expect((await f.stored()).secret).toMatchObject({ tokens: { accessToken: 'OLD_ACCESS_SECRET' }, imported: { state: 'owned' } });
  });

  test('an ambiguous provider refresh is durable and never repeated on a later refresh', async () => {
    const f = await setup(importedSecret(1));
    f.control.failure = true;
    for (const process of [f.first, f.second, f.first]) await f.refresh(process);
    expect(f.forms).toHaveLength(1);
    expect((await f.stored()).secret).toMatchObject({ imported: { state: 'uncertain' } });
  });

  test('a process lost after provider rotation but before the commit keeps the intent, not a second refresh', async () => {
    const f = await setup(importedSecret(1));
    const { store } = f.first;
    const lost: RefreshDeps = { ...f.first, store: { refresh: (identity, id, at, edit) => store.refresh(identity, id, at, async (current) => {
      const edited = await edit(current);
      const before = openConnectorSecret(MASTER, current.connector);
      const secret = edited.change.secret;
      const after = secret === undefined || secret === null ? null : openConnectorSecret(MASTER, { ...current.connector, secret });
      if (before?.kind === 'oauth' && before.imported?.state === 'refreshing' && after?.kind === 'oauth' && after.imported?.state === 'owned') throw new Error('fixture process lost before commit');
      return edited;
    }) } };
    await expect(f.refresh(lost)).rejects.toThrow('fixture process lost before commit');
    expect(f.forms).toHaveLength(1);
    expect((await f.stored()).secret).toMatchObject({ imported: { state: 'refreshing' } });
    await f.refresh(f.second);
    expect(f.forms).toHaveLength(1);
    expect((await f.stored()).secret).toMatchObject({ imported: { state: 'refreshing' } });
  });

  test('a process lost after the durable refresh intent but before dispatch does not guess whether the token was used', async () => {
    const f = await setup(importedSecret(1));
    const { store } = f.first;
    const lost: RefreshDeps = { ...f.first, store: { refresh: async (identity, id, at, edit) => {
      await store.refresh(identity, id, at, edit);
      const { secret } = await f.stored();
      if (secret?.kind === 'oauth' && secret.imported?.state === 'refreshing') throw new Error('fixture process lost after intent commit');
    } } };
    await expect(f.refresh(lost)).rejects.toThrow('fixture process lost after intent commit');
    expect(f.forms).toHaveLength(0);
    await f.refresh(f.second);
    expect(f.forms).toHaveLength(0);
    expect((await f.stored()).secret).toMatchObject({ imported: { state: 'refreshing' } });
  });
});

describe.skipIf(TEST_DATABASE_URL === undefined)('owned OAuth refresh across PostgreSQL connections', () => {
  test('simultaneous forced refreshes serialize on the row and use a rotating refresh token exactly once', async () => {
    const f = await setup(oauthSecret(Date.now() + 3600_000));
    const hold = f.hold();
    const revision = credentialRevision(MASTER, f.row);
    const one = f.refresh(f.first, revision);
    await hold.reached;
    const two = f.refresh(f.second, revision);
    await f.db.waiting('two');
    expect(f.forms.map((form) => form.get('refresh_token'))).toEqual(['REFRESH_OLD']);
    hold.release();
    expect(await Promise.all([one, two])).toEqual([new Map(), new Map()]);
    expect(f.forms).toHaveLength(1);
    expect((await f.stored()).secret).toMatchObject({ tokens: { accessToken: 'ROTATED_ACCESS_SECRET', refreshToken: 'ROTATED_REFRESH_SECRET' } });
  }, 20_000);

  test('simultaneous refreshes of an expired token also refresh once across processes', async () => {
    const f = await setup(oauthSecret());
    const hold = f.hold();
    const one = f.refresh(f.first);
    await hold.reached;
    const two = f.refresh(f.second);
    await f.db.waiting('two');
    hold.release();
    await Promise.all([one, two]);
    expect(f.forms).toHaveLength(1);
  }, 20_000);

  test('a sign-in that waited on a slow refresh wins, never overwritten by the refreshed tokens', async () => {
    const f = await setup(oauthSecret());
    const hold = f.hold();
    const pending = f.refresh(f.first);
    await hold.reached;
    const signin = signIn(f.db.db2, f.row);
    await f.db.waiting('two');
    hold.release();
    await signin;
    await pending;
    expect((await f.stored()).secret).toMatchObject({ tokens: { accessToken: 'SIGNIN_ACCESS', refreshToken: 'SIGNIN_REFRESH' } });
  }, 20_000);
});
