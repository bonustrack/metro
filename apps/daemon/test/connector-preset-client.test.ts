import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { allowLocalConnectors } from '../src/connectors/url.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEmit, startWebhookServer } from '../src/routes/http.ts';
import { localSessionApis } from '../src/routes/local-mode.ts';
import { setLocalOwner, LOCAL_PROJECT_ID } from '../src/agents/file-admin.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { localRelayTarget } from '../src/connectors/store.ts';
import { auth } from './identity-helper.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const RETURN_TO = 'https://metro.box/';
const CLIENT_ID = 'app-123';
const CLIENT_SECRET = 's3cret';
const saved = {
  dir: process.env.METRO_AGENTS_DIR,
  port: process.env.METRO_WEBHOOK_PORT,
  host: process.env.METRO_HTTP_HOST,
  pub: process.env.METRO_PUBLIC_URL,
  claude: process.env.METRO_CLAUDE_DIR,
};
let dir = '';
let vendor: Server;
let vendorBase = '';
let daemon: Server;
let base = '';
const tokenForms: URLSearchParams[] = [];
let registerCalls = 0;

interface StoredFile {
  connectors: {
    id: string;
    config: {
      client?: { clientId?: string; clientSecret?: string };
      auth: { kind: string; scope?: string; accessToken?: string; expiresAt?: number };
    };
  }[];
}

const rpc = (body: string): { method?: string; id?: number } => {
  try {
    return JSON.parse(body) as { method?: string; id?: number };
  } catch {
    return {};
  }
};

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function mcp(req: IncomingMessage, res: ServerResponse, body: string): void {
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!['at-1', 'at-2'].includes(bearer)) {
    res
      .writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${vendorBase}/.well-known/oauth-protected-resource/mcp"`,
      })
      .end();
    return;
  }
  const { method, id } = rpc(body);
  const result = (value: unknown): void => {
    reply(res, 200, { jsonrpc: '2.0', id: id ?? 1, result: value });
  };
  if (method === 'initialize')
    result({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mailtools', version: '1.0.0' } });
  else if (method === 'notifications/initialized') res.writeHead(202).end();
  else if (method === 'tools/list')
    result({ tools: [{ name: 'fetch', description: 'reads mail', inputSchema: { type: 'object' } }] });
  else res.writeHead(405).end();
}

function token(res: ServerResponse, body: string): void {
  const form = new URLSearchParams(body);
  tokenForms.push(form);
  if (form.get('grant_type') === 'authorization_code')
    reply(res, 200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' });
  else reply(res, 200, { access_token: 'at-2', expires_in: 3600, token_type: 'Bearer' });
}

function serve(req: IncomingMessage, res: ServerResponse, body: string): void {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path === '/mcp') mcp(req, res, body);
  else if (path === '/.well-known/oauth-protected-resource/mcp')
    reply(res, 200, {
      resource: `${vendorBase}/mcp`,
      authorization_servers: [`${vendorBase}/tenant/v2.0`],
      scopes_supported: [`${vendorBase}/mcp/.default`, 'offline_access'],
    });
  else if (path === '/tenant/v2.0/.well-known/openid-configuration')
    reply(res, 200, {
      issuer: `${vendorBase}/tenant/v2.0`,
      authorization_endpoint: `${vendorBase}/tenant/authorize`,
      token_endpoint: `${vendorBase}/tenant/token`,
    });
  else if (path === '/tenant/token') token(res, body);
  else if (path === '/tenant/register') {
    registerCalls += 1;
    reply(res, 404, { error: 'nobody registers here' });
  } else res.writeHead(404).end();
}

const listen = (server: Server): Promise<string> =>
  new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      done(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
    });
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-preset-client-'));
  process.env.METRO_AGENTS_DIR = dir;
  process.env.METRO_CLAUDE_DIR = join(dir, 'claude');
  delete process.env.METRO_PUBLIC_URL;
  setKeyMap([]);
  setLocalOwner(OWNER, dir);
  vendor = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString('utf8');
    });
    req.on('end', () => {
      serve(req, res, body);
    });
  });
  vendorBase = await listen(vendor);
  process.env.METRO_WEBHOOK_PORT = String(10000 + Math.floor(Math.random() * 20000));
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  const apis = localSessionApis({
    syncStations: () => Promise.resolve(),
    reloadAgents: () => Promise.resolve(),
    restart: () => undefined,
    stop: () => undefined,
    closeAgentSession: () => Promise.resolve(true),
    gatherAccounts: () => Promise.resolve({ accounts: {}, unavailable: [] }),
    capabilities: () => ({}),
    liveness: () => new Map(),
    prepareAccount: () => Promise.reject(new Error('not used')),
  });
  daemon = await startWebhookServer(makeEmit(), apis, async (_req, res) => {
    res.writeHead(404).end();
  });
  base = `http://127.0.0.1:${String((daemon.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  allowLocalConnectors(false);
  await new Promise<void>((done) => daemon.close(() => done()));
  vendor.close();
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of [
    ['METRO_AGENTS_DIR', saved.dir],
    ['METRO_WEBHOOK_PORT', saved.port],
    ['METRO_HTTP_HOST', saved.host],
    ['METRO_PUBLIC_URL', saved.pub],
    ['METRO_CLAUDE_DIR', saved.claude],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

const J = { 'content-type': 'application/json' };
const call = async (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: await auth(method, path, OWNER), ...(body === undefined ? {} : J) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
  });

const stored = (): StoredFile =>
  JSON.parse(readFileSync(join(dir, 'connectors.json'), 'utf8')) as StoredFile;

const lastForm = (): URLSearchParams => {
  const form = tokenForms[tokenForms.length - 1];
  if (form === undefined) throw new Error('no token request was made');
  return form;
};

let outlook = '';
let authorize = new URL('https://unset.example');

describe('a connector whose authorization server registers no clients', () => {
  test('without a client id the create is refused, names the callback url, and stores no half row', async () => {
    const res = await call('POST', `/api/connectors?project=${LOCAL_PROJECT_ID}`, {
      name: 'outlook',
      url: `${vendorBase}/mcp`,
      returnTo: RETURN_TO,
    });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('client ID');
    expect(error).toContain(`${base}/api/connectors/callback`);
    const list = await call('GET', `/api/connectors?project=${LOCAL_PROJECT_ID}`);
    expect(((await list.json()) as { connectors: unknown[] }).connectors).toEqual([]);
    expect(registerCalls).toBe(0);
  });

  test('a secret without a client id, or an unsendable client id, is refused before any network call', async () => {
    const secretOnly = await call('POST', `/api/connectors?project=${LOCAL_PROJECT_ID}`, {
      name: 'outlook',
      url: `${vendorBase}/mcp`,
      clientSecret: CLIENT_SECRET,
    });
    expect(secretOnly.status).toBe(400);
    expect(((await secretOnly.json()) as { error: string }).error).toContain('client ID');
    const spaced = await call('POST', `/api/connectors?project=${LOCAL_PROJECT_ID}`, {
      name: 'outlook',
      url: `${vendorBase}/mcp`,
      clientId: 'app 123',
    });
    expect(spaced.status).toBe(400);
  });

  test('with a pre-registered client the row is stored and the sign-in url carries that client, the scopes and the callback', async () => {
    const res = await call('POST', `/api/connectors?project=${LOCAL_PROJECT_ID}`, {
      name: 'outlook',
      url: `${vendorBase}/mcp`,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      returnTo: RETURN_TO,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    outlook = body.id as string;
    expect(body).toMatchObject({ name: 'outlook', signIn: 'disconnected', clientId: CLIENT_ID, auth: 'none' });
    expect(Object.keys(body)).not.toContain('clientSecret');
    authorize = new URL(body.authorizeUrl as string);
    expect(authorize.origin + authorize.pathname).toBe(`${vendorBase}/tenant/authorize`);
    expect(authorize.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(authorize.searchParams.get('scope')).toBe(`${vendorBase}/mcp/.default offline_access`);
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${base}/api/connectors/callback`);
    expect(authorize.searchParams.get('resource')).toBe(`${vendorBase}/mcp`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const [row] = stored().connectors;
    expect(row?.config.client).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(registerCalls).toBe(0);
  });

  test('the callback exchanges the code as that client, stores the tokens with their scope, and verifies the server', async () => {
    const state = authorize.searchParams.get('state') ?? '';
    const res = await fetch(`${base}/api/connectors/callback?state=${state}&code=code-1`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${RETURN_TO}#/connector/${outlook}`);
    const form = lastForm();
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('code-1');
    expect(form.get('client_id')).toBe(CLIENT_ID);
    expect(form.get('client_secret')).toBe(CLIENT_SECRET);
    expect(form.get('redirect_uri')).toBe(`${base}/api/connectors/callback`);
    expect(form.get('code_verifier') ?? '').toMatch(/^[A-Za-z0-9_-]{43,}$/);
    const shown = await call('GET', `/api/connectors/${outlook}`);
    const row = (await shown.json()) as Record<string, unknown>;
    expect(row).toMatchObject({ signIn: 'connected', auth: 'oauth', clientId: CLIENT_ID });
    expect((row.verified as { tools: number; server: string })).toMatchObject({ tools: 1, server: 'mailtools' });
    const [file] = stored().connectors;
    expect(file?.config.auth).toMatchObject({ kind: 'oauth', accessToken: 'at-1', scope: `${vendorBase}/mcp/.default offline_access` });
  });

  test('a refresh sends the same client and the stored scope, which is what Entra wants back', async () => {
    const file = stored();
    const row = file.connectors[0];
    if (row === undefined) throw new Error('no row');
    row.config.auth.expiresAt = Date.now() - 1;
    writeFileSync(join(dir, 'connectors.json'), JSON.stringify(file));
    const target = await localRelayTarget(outlook, false, dir);
    expect(target).toEqual({ kind: 'ok', url: `${vendorBase}/mcp`, headers: { Authorization: 'Bearer at-2' } });
    const form = lastForm();
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('rt-1');
    expect(form.get('scope')).toBe(`${vendorBase}/mcp/.default offline_access`);
    expect(form.get('client_id')).toBe(CLIENT_ID);
    expect(form.get('client_secret')).toBe(CLIENT_SECRET);
  });

  test('signing out keeps the app, so Connect signs in again as the same client with no registration', async () => {
    const out = await call('POST', `/api/connectors/${outlook}/disconnect`);
    expect(out.status).toBe(200);
    expect(await out.json()).toMatchObject({ signIn: 'disconnected', clientId: CLIENT_ID });
    const again = await call('POST', `/api/connectors/${outlook}/connect`, { returnTo: RETURN_TO });
    expect(again.status).toBe(202);
    const { authorizeUrl } = (await again.json()) as { authorizeUrl: string };
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('scope')).toBe(`${vendorBase}/mcp/.default offline_access`);
    expect(registerCalls).toBe(0);
  });
});
