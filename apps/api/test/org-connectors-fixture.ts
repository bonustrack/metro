import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { OwnerTickets } from '../src/agents/tickets.ts';
import { handleConnectorsApiRequest, type ConnectorsApiDeps } from '../src/connectors/api.ts';
import type { Handoff, SignInState } from '../src/connectors/sign-in.ts';
import { orgConnectorStore } from '../src/db/connectors.ts';
import { users } from '../src/db/schema.ts';
import { testKeys } from './identity-helper.ts';
import type { TestDb } from './pglite-db.ts';

export const GOOD_KEY = 'Bearer good-vendor-key-fixture';
export const ACCESS = 'access-token-fixture';
export const REFRESH = 'refresh-token-fixture';
export const RETURN_TO = 'http://localhost:8081/';
export const CALLBACK = 'https://api.metro.box/api/connectors/callback';

export interface VendorReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface Vendor {
  base: string;
  resource: string | null;
  fetch: FetchLike;
  requests: { url: string; method: string; headers: Headers; body: string }[];
  received: { path: string; method: string; authorization: string }[];
  replies: Map<string, VendorReply>;
  oauthPaths: Set<string>;
  openPaths: Set<string>;
  keyedPaths: Set<string>;
  serverTitle: string | null;
  challenges: Map<string, string>;
  tokenForms: URLSearchParams[];
  tokenCalls: number;
  registrations: number;
  close: () => Promise<void>;
}

export interface Api {
  base: string;
  deps: ConnectorsApiDeps;
  setKey: (key: Buffer | null) => void;
  close: () => Promise<void>;
}

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(randomInt(10_000, 30_000), '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
};

const closing = (server: Server): Promise<void> =>
  new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
};

const initialized = (res: ServerResponse, name: string): void => {
  json(res, 200, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name } } });
};

async function bodyText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function mcp(vendor: Vendor, req: IncomingMessage, res: ServerResponse, path: string): boolean {
  const auth = req.headers.authorization ?? '';
  if (vendor.openPaths.has(path)) initialized(res, vendor.serverTitle ?? 'Open MCP');
  else if (path === '/query-keyed') {
    if (new URL(req.url ?? '', vendor.base).searchParams.get('api_key') === 'URL_ONLY_SECRET') initialized(res, vendor.serverTitle ?? 'Query MCP');
    else json(res, 401, { error: 'unauthorized' });
  }
  else if (vendor.keyedPaths.has(path)) {
    if (auth === GOOD_KEY) initialized(res, vendor.serverTitle ?? 'Keyed MCP');
    else json(res, 401, { error: 'unauthorized' });
  } else if (vendor.oauthPaths.has(path)) {
    if (auth === `Bearer ${ACCESS}`) initialized(res, vendor.serverTitle ?? 'OAuth MCP');
    else json(res, 401, { error: 'unauthorized' });
  } else return false;
  return true;
}

async function token(vendor: Vendor, req: IncomingMessage, res: ServerResponse): Promise<void> {
  vendor.tokenCalls += 1;
  const form = new URLSearchParams(await bodyText(req));
  vendor.tokenForms.push(form);
  const code = form.get('code') ?? '';
  const challenge = vendor.challenges.get(code);
  const verifier = form.get('code_verifier') ?? '';
  const refreshed = form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === REFRESH;
  const exchanged = challenge !== undefined && createHash('sha256').update(verifier).digest('base64url') === challenge && form.get('redirect_uri') === CALLBACK;
  if ((!refreshed && !exchanged) || form.get('resource') !== vendor.resource) {
    json(res, 400, { error: 'invalid_grant' });
    return;
  }
  vendor.challenges.delete(code);
  json(res, 200, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, token_type: 'Bearer' });
}

async function oauthServer(vendor: Vendor, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (path === '/.well-known/oauth-protected-resource' || (vendor.resource !== null && path === `/.well-known/oauth-protected-resource${new URL(vendor.resource).pathname}`))
    json(res, 200, { ...(vendor.resource === null ? {} : { resource: vendor.resource }), authorization_servers: [vendor.base], scopes_supported: ['read'] });
  else if (path === '/.well-known/oauth-authorization-server')
    json(res, 200, { issuer: vendor.base, authorization_endpoint: `${vendor.base}/authorize`, token_endpoint: `${vendor.base}/token`, registration_endpoint: `${vendor.base}/register`, code_challenge_methods_supported: ['S256'] });
  else if (path === '/register') {
    vendor.registrations += 1;
    json(res, 201, { client_id: `client-${String(vendor.registrations)}` });
  } else if (path === '/token') await token(vendor, req, res);
  else json(res, 404, { error: 'not found' });
}

export async function startVendor(): Promise<Vendor> {
  const localFetch = globalThis.fetch;
  const base = 'https://vendor.example.com';
  let local = '';
  const vendor: Vendor = {
    base, resource: `${base}/oauth`, requests: [], received: [], replies: new Map(), oauthPaths: new Set(['/oauth']), openPaths: new Set(['/open']), keyedPaths: new Set(['/keyed']), serverTitle: null,
    challenges: new Map(), tokenForms: [], tokenCalls: 0, registrations: 0, close: () => Promise.resolve(),
    fetch: (raw, init) => {
      const url = new URL(raw);
      if (url.origin !== base || url.username !== '' || url.password !== '' || url.hash !== '' || init?.redirect !== 'manual') throw new Error('Unexpected provider request in isolated fixture');
      vendor.requests.push({ url: raw, method: init.method ?? 'GET', headers: new Headers(init.headers), body: typeof init.body === 'string' ? init.body : '' });
      return localFetch(`${local}${url.pathname}${url.search}`, init);
    },
  };
  const server = createServer((req, res) => {
    vendor.received.push({ path: req.url ?? '', method: req.method ?? '', authorization: req.headers.authorization ?? '' });
    const path = (req.url ?? '').split('?')[0] ?? '';
    const reply = vendor.replies.get(path);
    if (reply !== undefined) { json(res, reply.status, reply.body, reply.headers); return; }
    if (req.method === 'POST' && mcp(vendor, req, res, path)) return;
    oauthServer(vendor, req, res, path).catch(() => {
      json(res, 500, { error: 'vendor fixture failed' });
    });
  });
  local = await listen(server);
  vendor.close = () => closing(server);
  return vendor;
}

export async function startApi(db: () => TestDb['db'], now: () => number, send: FetchLike): Promise<Api> {
  let key: Buffer | null = randomBytes(32);
  const deps: ConnectorsApiDeps = {
    key: () => key,
    keys: await testKeys(),
    store: orgConnectorStore(db),
    fetch: send,
    httpsOnly: true,
    callbackUrl: CALLBACK,
    states: new OwnerTickets<SignInState>((state) => state.connector, { what: 'connector sign-ins' }),
    handoffs: new OwnerTickets<Handoff>((handoff) => handoff.connector, { what: 'connector sign-ins', ttlMs: 5 * 60_000 }),
    now,
  };
  const server = createServer((req, res) => {
    if (!handleConnectorsApiRequest(req, res, deps)) res.writeHead(404).end();
  });
  const base = await listen(server);
  return {
    base,
    deps,
    setKey: (next) => {
      key = next;
    },
    close: () => closing(server),
  };
}

export async function addUser(db: TestDb['db'], id: string, name: string, email: string): Promise<void> {
  await db.insert(users).values({ id, name, email, updatedAt: '2026-10-11T00:00:00.000Z' });
}

export function challengeOf(authorizeUrl: string): { state: string; challenge: string; clientId: string; resource: string } {
  const url = new URL(authorizeUrl);
  return {
    state: url.searchParams.get('state') ?? '',
    challenge: url.searchParams.get('code_challenge') ?? '',
    clientId: url.searchParams.get('client_id') ?? '',
    resource: url.searchParams.get('resource') ?? '',
  };
}
