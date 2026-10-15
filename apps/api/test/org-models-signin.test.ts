import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { openSecret } from '@metro-labs/connectors/secrets';
import { modelConnections, modelHosts } from '../src/db/schema.ts';
import { auth, bearer, TEST_OWNER } from './identity-helper.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { CALLBACK, idToken, json, provider, startApi, type Api, type Provider, type SentRequest } from './org-models-fixture.ts';

const ISSUER = 'https://auth.openai.com';
const TOKEN = `POST ${ISSUER}/api/accounts/oauth/token`;
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';

let held: TestDb;
let api: Api;
let vendor: Provider;
let now = Date.parse('2026-10-15T08:00:00.000Z');

interface View {
  id: string;
  provider: string;
  account: { email: string | null; plan: string | null; method: string | null };
}

const call = async (method: string, path: string, body?: unknown, authorization?: string): Promise<Response> => {
  now += 1;
  return fetch(`${api.base}${path}`, {
    method,
    redirect: 'manual',
    headers: { authorization: authorization ?? (await auth(TEST_OWNER)), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
};

const data = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const formOf = (sent: SentRequest | undefined): Record<string, string> => Object.fromEntries(new URLSearchParams(sent?.body ?? ''));

async function begin(body: Record<string, unknown> = {}): Promise<URL> {
  const res = await call('POST', '/api/models/codex/login', body);
  expect(res.status).toBe(200);
  return new URL((await data<{ authorizeUrl: string }>(res)).authorizeUrl);
}

function grant(subject: string, clientId: string, nonce: string): void {
  vendor.replies.set(TOKEN, () => json({ access_token: 'ACCESS_1', refresh_token: 'REFRESH_1', expires_in: 3600, scope: `openid ${PLAN_SCOPE}`, id_token: idToken({ iss: ISSUER, aud: clientId, nonce, sub: subject, email: 'less@example.com' }) }));
}

const landed = (url: URL, clientId: string): string => `http://127.0.0.1:1455/auth/callback?code=CODE_1&state=${url.searchParams.get('state') ?? ''}&client_id=${clientId}`;

beforeAll(async () => {
  held = await testDb();
  vendor = provider();
  api = await startApi(() => held.db, () => now, vendor.fetch);
}, PGLITE_START_MS);

beforeEach(async () => {
  now += 60_000;
  vendor.sent.length = 0;
  vendor.replies.clear();
  await held.reset();
}, PGLITE_STEP_MS);

afterAll(async () => {
  await api.close();
  await held.close();
});

describe('Continue with ChatGPT', () => {
  test('registers Metro with the organization host id, checks the identity, and keeps the issued client', async () => {
    const url = await begin();
    const host = (await held.db.select().from(modelHosts).where(eq(modelHosts.owner, TEST_OWNER)))[0]?.chatgptHostId;
    expect(url.origin + url.pathname).toBe(`${ISSUER}/api/accounts/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'dynamic_agent_client', agent_name_hint: 'Metro', ext_agent_host_id: host ?? 'missing', response_type: 'code',
      redirect_uri: 'http://127.0.0.1:1455/auth/callback', scope: `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`,
      resource: 'https://api.openai.com/v1', code_challenge_method: 'S256',
    });
    grant('user-sub-1', 'oaiapp_issued', url.searchParams.get('nonce') ?? '');
    const res = await call('POST', '/api/models/codex/callback', { url: landed(url, 'oaiapp_issued') });
    expect(res.status).toBe(200);
    const { connection } = await data<{ connection: View }>(res);
    expect(connection).toMatchObject({ provider: 'codex', account: { email: 'less@example.com', method: 'chatgpt' } });
    const form = formOf(vendor.sent[0]);
    expect(form).toMatchObject({ grant_type: 'authorization_code', client_id: 'oaiapp_issued', code: 'CODE_1', redirect_uri: 'http://127.0.0.1:1455/auth/callback', resource: 'https://api.openai.com/v1' });
    expect(createHash('sha256').update(form.code_verifier ?? '').digest('base64url')).toBe(url.searchParams.get('code_challenge') ?? '');
    const row = (await held.db.select().from(modelConnections).where(eq(modelConnections.id, connection.id)))[0];
    const key = api.models.key();
    if (row?.secret === null || row === undefined || key === null) throw new Error('not stored');
    expect(openSecret(key, TEST_OWNER, row.id, row.secret, 'model')).toMatchObject({ kind: 'codex', method: 'chatgpt', clientId: 'oaiapp_issued', subject: 'user-sub-1', refreshToken: 'REFRESH_1' });
    expect((await call('POST', '/api/models/codex/callback', { url: landed(url, 'oaiapp_issued') })).status).toBe(400);
  });

  test('signing a connection in again reuses its client, and another account there is refused', async () => {
    const first = await begin();
    grant('user-sub-1', 'oaiapp_issued', first.searchParams.get('nonce') ?? '');
    const { connection } = await data<{ connection: View }>(await call('POST', '/api/models/codex/callback', { url: landed(first, 'oaiapp_issued') }));
    const again = await begin({ connection: connection.id });
    expect(again.searchParams.get('client_id')).toBe('oaiapp_issued');
    expect(again.searchParams.get('login_hint')).toBe('less@example.com');
    expect(again.searchParams.has('agent_name_hint')).toBe(false);
    grant('user-sub-2', 'oaiapp_issued', again.searchParams.get('nonce') ?? '');
    expect((await call('POST', '/api/models/codex/callback', { url: landed(again, 'oaiapp_issued') })).status).toBe(409);
  });

  test('a sign-in finishes only for the person who started it, and a wrong nonce or scope saves nothing', async () => {
    const url = await begin();
    grant('user-sub-1', 'oaiapp_issued', url.searchParams.get('nonce') ?? '');
    const other = await bearer({ org_id: TEST_OWNER, role: 'admin', sub: 'user_02OTHER' });
    expect((await call('POST', '/api/models/codex/callback', { url: landed(url, 'oaiapp_issued') }, other)).status).toBe(403);
    const wrong = await begin();
    grant('user-sub-1', 'oaiapp_issued', 'another-nonce');
    expect((await call('POST', '/api/models/codex/callback', { url: landed(wrong, 'oaiapp_issued') })).status).toBe(400);
    expect((await call('POST', '/api/models/codex/callback', { url: 'http://127.0.0.1:1455/auth/callback?error=access_denied' })).status).toBe(400);
    expect(await held.db.$count(modelConnections)).toBe(0);
  });
});

describe('Sign in with a code', () => {
  test('polls no faster than OpenAI asks, then keeps a code connection', async () => {
    vendor.replies.set(`POST ${ISSUER}/api/accounts/deviceauth/usercode`, () => json({ device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: 5 }));
    let approved = false;
    vendor.replies.set(`POST ${ISSUER}/api/accounts/deviceauth/token`, () => (approved ? json({ authorization_code: 'AUTH_CODE', code_verifier: 'VERIFIER' }) : json({}, 403)));
    vendor.replies.set(`POST ${ISSUER}/oauth/token`, () => json({ access_token: 'ACCESS_C', refresh_token: 'REFRESH_C', expires_in: 3600, id_token: idToken({ email: 'code@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-7', chatgpt_plan_type: 'plus' } }) }));
    const started = await data<{ id: string; user_code: string; verify_url: string; interval: number }>(await call('POST', '/api/models/codex/device', {}));
    expect(started).toMatchObject({ user_code: 'ABCD-1234', verify_url: `${ISSUER}/codex/device`, interval: 5 });
    expect(await data<unknown>(await call('GET', `/api/models/codex/device/${started.id}`))).toEqual({ status: 'pending' });
    expect(await data<unknown>(await call('GET', `/api/models/codex/device/${started.id}`))).toEqual({ status: 'pending' });
    expect(vendor.sent.filter((sent) => sent.url.endsWith('/deviceauth/token'))).toHaveLength(1);
    approved = true;
    now += 6_000;
    const done = await data<{ status: string; connection: View }>(await call('GET', `/api/models/codex/device/${started.id}`));
    expect(done).toMatchObject({ status: 'done', connection: { provider: 'codex', account: { email: 'code@example.com', plan: 'plus', method: 'code' } } });
    expect(formOf(vendor.sent.at(-1))).toEqual({ grant_type: 'authorization_code', code: 'AUTH_CODE', redirect_uri: `${ISSUER}/deviceauth/callback`, client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', code_verifier: 'VERIFIER' });
    expect((await call('GET', `/api/models/codex/device/${started.id}`)).status).toBe(404);
  });
});

describe('OpenRouter sign-in', () => {
  test('the callback stores the key and sends the admin back to the Models page', async () => {
    const res = await call('POST', '/api/models/openrouter/login', { returnTo: 'http://localhost:8081/' });
    const url = new URL((await data<{ authorizeUrl: string }>(res)).authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
    expect(url.searchParams.get('callback_url')).toBe(CALLBACK);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    vendor.replies.set('POST https://openrouter.ai/api/v1/auth/keys', () => json({ key: 'sk-or-from-oauth' }));
    const back = await fetch(`${api.base}/api/models/openrouter/callback?code=OR_CODE&state=${url.searchParams.get('state') ?? ''}`, { redirect: 'manual' });
    expect(back.status).toBe(302);
    const location = new URL(back.headers.get('location') ?? '');
    expect(`${location.origin}/`).toBe('http://localhost:8081/');
    const id = new URLSearchParams(location.hash.split('?')[1]).get('openrouter') ?? '';
    expect(location.hash).toBe(`#/${TEST_OWNER}/organization/models?openrouter=${id}`);
    const sent = JSON.parse(vendor.sent[0]?.body ?? '{}') as Record<string, string>;
    expect(sent.code).toBe('OR_CODE');
    expect(createHash('sha256').update(sent.code_verifier ?? '').digest('base64url')).toBe(url.searchParams.get('code_challenge') ?? '');
    expect(await held.db.$count(modelConnections, eq(modelConnections.id, id))).toBe(1);
    const reused = await fetch(`${api.base}/api/models/openrouter/callback?code=OR_CODE&state=${url.searchParams.get('state') ?? ''}`, { redirect: 'manual' });
    expect(reused.headers.get('location')).toContain('openrouter_error=');
  });

  test('a refused exchange comes back as an error the page can show', async () => {
    const res = await call('POST', '/api/models/openrouter/login', {});
    const url = new URL((await data<{ authorizeUrl: string }>(res)).authorizeUrl);
    vendor.replies.set('POST https://openrouter.ai/api/v1/auth/keys', () => json({ error: 'bad code' }, 400));
    const back = await fetch(`${api.base}/api/models/openrouter/callback?code=OR_CODE&state=${url.searchParams.get('state') ?? ''}`, { redirect: 'manual' });
    expect(back.headers.get('location')).toStartWith(`https://metro.box/#/${TEST_OWNER}/organization/models?openrouter_error=`);
    expect(await held.db.$count(modelConnections)).toBe(0);
    expect((await call('POST', '/api/models/openrouter/login', { returnTo: 'https://evil.example/' })).status).toBe(400);
  });
});
