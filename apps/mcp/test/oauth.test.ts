import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { approveGrant, denyGrant, GRANT_CODE_MS, GRANT_REQUEST_MS, GRANTS_OPEN_MAX, pendingGrant } from '@metro-labs/connectors/db/oauth-grants';
import { oauthGrants } from '@metro-labs/connectors/db/schema';
import { agents, agentTokens } from '@metro-labs/connectors/db/schema';
import { APP_URL, HOST, OWNER, PGLITE_START_MS, rpc, startApp, STRANGER, testDb, type TestApp, type TestDb } from './helpers.ts';

const AGENT = 'agent000001';
const ADMIN = 'user_01ADMIN';
const ISSUER = `https://${HOST}`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const START = Date.parse('2026-11-04T09:00:00.000Z');

let held: TestDb;
let app: TestApp;
let now = START;

const pkce = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function register(body: unknown = { client_name: 'Claude', redirect_uris: [REDIRECT] }): Promise<Response> {
  return fetch(`${app.base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function clientId(redirects = [REDIRECT]): Promise<string> {
  const body = (await (await register({ client_name: 'Claude', redirect_uris: redirects })).json()) as { client_id: string };
  return body.client_id;
}

async function authorize(params: Record<string, string>): Promise<Response> {
  return fetch(`${app.base}/oauth/authorize?${new URLSearchParams(params).toString()}`, { redirect: 'manual' });
}

const authorizeParams = (client: string, challenge: string, extra: Record<string, string> = {}): Record<string, string> => ({ response_type: 'code', client_id: client, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', ...extra });

function grantIdOf(res: Response): string {
  const location = res.headers.get('location') ?? '';
  expect(location.startsWith(`${APP_URL}/#/connect/`)).toBe(true);
  return location.slice(`${APP_URL}/#/connect/`.length);
}

async function token(params: Record<string, string>): Promise<Response> {
  return fetch(`${app.base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
}

async function approvedCode(client: string, challenge: string): Promise<string> {
  const id = grantIdOf(await authorize(authorizeParams(client, challenge)));
  const redirect = new URL(await approveGrant(held.db, { id, owner: OWNER, agent: AGENT, by: ADMIN, now }));
  expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
  expect(redirect.searchParams.get('state')).toBe('st-1');
  return redirect.searchParams.get('code') ?? '';
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } } };

beforeAll(async () => {
  held = await testDb();
}, PGLITE_START_MS);

beforeEach(async () => {
  await held.reset();
  now = START;
  await held.db.insert(agents).values({ id: AGENT, owner: OWNER, kind: 'remote', host: null, name: 'Laptop', addedAt: '2026-11-04T00:00:00.000Z', slug: AGENT });
  app = await startApp(held.db, fetch, { now: () => now });
});

afterEach(async () => { await app.close(); });
afterAll(async () => { await held.close(); });

describe('sign-in metadata', () => {
  test('the protected resource names mcp.metro.box as its authorization server, for / and /mcp', async () => {
    const root = (await (await fetch(`${app.base}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
    expect(root).toMatchObject({ resource: ISSUER, authorization_servers: [ISSUER], scopes_supported: ['connectors'] });
    const mcp = (await (await fetch(`${app.base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(mcp.resource).toBe(`${ISSUER}/mcp`);
  });

  test('the authorization server takes public clients with PKCE S256 only', async () => {
    const res = await fetch(`${app.base}/.well-known/oauth-authorization-server`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      registration_endpoint: `${ISSUER}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });
});

describe('registration', () => {
  test('a client gets a signed id and nothing is stored', async () => {
    const res = await register();
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
    expect(String(body.client_id).startsWith('mc1.')).toBe(true);
  });

  test('unsafe or missing return addresses are refused', async () => {
    for (const redirect_uris of [[], ['http://evil.example/cb'], ['javascript:alert(1)'], ['https://claude.ai/cb#x'], ['https://user:pw@claude.ai/cb'], 'https://claude.ai/cb']) {
      expect((await register({ redirect_uris })).status).toBe(400);
    }
    for (const redirect of ['http://127.0.0.1:33418/callback', 'http://localhost/cb', 'cursor://anysphere.cursor-mcp/oauth/callback']) {
      expect((await register({ redirect_uris: [redirect] })).status).toBe(201);
    }
  });
});

describe('authorize', () => {
  test('a forged client or an unregistered return address is refused without a redirect', async () => {
    const client = await clientId();
    const forged = `${client.slice(0, -2)}AA`;
    expect((await authorize(authorizeParams(forged, pkce().challenge))).status).toBe(400);
    expect((await authorize(authorizeParams(client, pkce().challenge, { redirect_uri: 'https://evil.example/cb' }))).status).toBe(400);
  });

  test('a request without PKCE S256 goes back to the app with an error', async () => {
    const client = await clientId();
    const res = await authorize(authorizeParams(client, pkce().challenge, { code_challenge_method: 'plain' }));
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get('location') ?? '');
    expect(back.searchParams.get('error')).toBe('invalid_request');
    expect(back.searchParams.get('state')).toBe('st-1');
  });

  test('another resource is refused', async () => {
    const res = await authorize(authorizeParams(await clientId(), pkce().challenge, { resource: 'https://mcp.example.com' }));
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe('invalid_target');
  });

  test('a good request opens a grant and sends the person to metro.box', async () => {
    const client = await clientId();
    const id = grantIdOf(await authorize(authorizeParams(client, pkce().challenge, { resource: `${ISSUER}/mcp` })));
    expect(await pendingGrant(held.db, id, now)).toMatchObject({ clientName: 'Claude', redirectUri: REDIRECT, state: 'st-1' });
    expect(await pendingGrant(held.db, id, now + GRANT_REQUEST_MS)).toBeNull();
  });

  test('too many waiting sign-ins are refused, and expired ones make room again', async () => {
    const client = await clientId();
    const rows = Array.from({ length: GRANTS_OPEN_MAX }, (_, i) => ({ id: `filler${String(i).padStart(5, '0')}`, clientId: client, clientName: 'Claude', redirectUri: REDIRECT, codeChallenge: pkce().challenge, createdAt: now, expiresAt: now + GRANT_REQUEST_MS }));
    for (let i = 0; i < rows.length; i += 1000) await held.db.insert(oauthGrants).values(rows.slice(i, i + 1000));
    expect((await authorize(authorizeParams(client, pkce().challenge))).status).toBe(503);
    now += GRANT_REQUEST_MS + 1;
    expect((await authorize(authorizeParams(client, pkce().challenge))).status).toBe(302);
  });
});

describe('token', () => {
  test('an approved code becomes an access key that opens the MCP endpoint, once', async () => {
    const client = await clientId();
    const { verifier, challenge } = pkce();
    const code = await approvedCode(client, challenge);
    const res = await token({ grant_type: 'authorization_code', code, client_id: client, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body).toMatchObject({ token_type: 'Bearer', scope: 'connectors' });
    expect(body.access_token?.startsWith('mcp_')).toBe(true);
    expect((await rpc(app, body.access_token ?? '', initialize)).status).toBe(200);
    const keys = await held.db.select().from(agentTokens).where(eq(agentTokens.agent, AGENT));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ label: 'Claude', createdBy: ADMIN, scopes: ['connectors'] });
    const again = await token({ grant_type: 'authorization_code', code, client_id: client, code_verifier: verifier });
    expect(again.status).toBe(400);
    expect(((await again.json()) as Record<string, string>).error).toBe('invalid_grant');
  });

  test('a wrong verifier, another client or an expired code gets no key', async () => {
    const client = await clientId();
    const other = await clientId([REDIRECT, 'https://claude.ai/other']);
    for (const params of [
      (code: string, verifier: string) => ({ code, client_id: client, code_verifier: `${verifier}x` }),
      (code: string, verifier: string) => ({ code, client_id: other, code_verifier: verifier }),
    ]) {
      const { verifier, challenge } = pkce();
      const code = await approvedCode(client, challenge);
      expect((await token({ grant_type: 'authorization_code', ...params(code, verifier) })).status).toBe(400);
    }
    const { verifier, challenge } = pkce();
    const code = await approvedCode(client, challenge);
    now += GRANT_CODE_MS;
    expect((await token({ grant_type: 'authorization_code', code, client_id: client, code_verifier: verifier })).status).toBe(400);
    expect(await held.db.$count(agentTokens)).toBe(0);
  });

  test('a code for an agent that moved to another organization gets no key', async () => {
    const client = await clientId();
    const { verifier, challenge } = pkce();
    const code = await approvedCode(client, challenge);
    await held.db.update(agents).set({ owner: STRANGER }).where(eq(agents.id, AGENT));
    const res = await token({ grant_type: 'authorization_code', code, client_id: client, code_verifier: verifier });
    expect(res.status).toBe(400);
  });

  test('a loopback client may come back on another port, and refresh is not offered', async () => {
    const loopback = 'http://127.0.0.1:33418/callback';
    const client = await clientId([loopback]);
    const { challenge } = pkce();
    const res = await authorize(authorizeParams(client, challenge, { redirect_uri: 'http://127.0.0.1:40111/callback' }));
    expect(res.status).toBe(302);
    expect((await token({ grant_type: 'refresh_token', refresh_token: 'x', client_id: client })).status).toBe(400);
  });

  test('a declined grant goes back with access_denied and cannot be approved', async () => {
    const client = await clientId();
    const id = grantIdOf(await authorize(authorizeParams(client, pkce().challenge)));
    const back = new URL(await denyGrant(held.db, id, now));
    expect(back.searchParams.get('error')).toBe('access_denied');
    await expect(approveGrant(held.db, { id, owner: OWNER, agent: AGENT, by: ADMIN, now })).rejects.toThrow('no longer open');
  });
});
