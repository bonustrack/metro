import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { readBodyBytes } from '@metro-labs/http/api-http';
import { clientFromRegistration, clientIdOf } from './clients.js';
import { authorize, exchange, OAUTH_SCOPE, type OauthDeps, type TokenAnswer } from './flow.js';

const BODY_MAX = 16 * 1024;
const OPEN = { 'access-control-allow-origin': '*' };
const PREFLIGHT = { ...OPEN, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version', 'access-control-max-age': '86400' };
const RESOURCE_PATH = '/.well-known/oauth-protected-resource';
const SERVER_PATH = '/.well-known/oauth-authorization-server';
const PATHS = new Set([RESOURCE_PATH, `${RESOURCE_PATH}/mcp`, SERVER_PATH, '/oauth/register', '/oauth/authorize', '/oauth/token']);

export const resourceMetadataUrl = (issuer: string, path: string): string => `${issuer}${RESOURCE_PATH}${path === '/mcp' ? '/mcp' : ''}`;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...OPEN, ...headers });
  res.end(JSON.stringify(body));
}

const resourceMetadata = (issuer: string, path: string): Record<string, unknown> => ({
  resource: path === `${RESOURCE_PATH}/mcp` ? `${issuer}/mcp` : issuer,
  authorization_servers: [issuer],
  scopes_supported: [OAUTH_SCOPE],
  bearer_methods_supported: ['header'],
  resource_name: 'Metro',
  resource_documentation: 'https://metro.box',
});

const serverMetadata = (issuer: string): Record<string, unknown> => ({
  issuer,
  authorization_endpoint: `${issuer}/oauth/authorize`,
  token_endpoint: `${issuer}/oauth/token`,
  registration_endpoint: `${issuer}/oauth/register`,
  scopes_supported: [OAUTH_SCOPE],
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
});

function parsedJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

async function register(req: IncomingMessage, res: ServerResponse, deps: OauthDeps): Promise<void> {
  const client = clientFromRegistration(parsedJson(await readBodyBytes(req, BODY_MAX)), deps.now());
  if (typeof client === 'string') {
    send(res, 400, { error: 'invalid_redirect_uri', error_description: client });
    return;
  }
  log.info({ client: client.name, redirects: client.redirectUris.length }, 'mcp: an app registered for sign-in');
  send(res, 201, {
    client_id: clientIdOf(deps.clientKey, client),
    client_id_issued_at: client.issuedAt,
    client_name: client.name,
    redirect_uris: client.redirectUris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
}

function formOf(bytes: Buffer, type: string): URLSearchParams {
  const text = bytes.toString('utf8');
  if (!type.includes('application/json')) return new URLSearchParams(text);
  const value = parsedJson(bytes);
  const params = new URLSearchParams();
  if (isRecord(value)) for (const [name, field] of Object.entries(value)) if (typeof field === 'string') params.set(name, field);
  return params;
}

async function token(req: IncomingMessage, res: ServerResponse, deps: OauthDeps): Promise<void> {
  const params = formOf(await readBodyBytes(req, BODY_MAX), req.headers['content-type'] ?? '');
  const answer: TokenAnswer = await exchange(deps, params);
  send(res, answer.status, answer.body, { pragma: 'no-cache' });
}

async function authorizeRequest(req: IncomingMessage, res: ServerResponse, deps: OauthDeps): Promise<void> {
  const outcome = await authorize(deps, new URL(req.url ?? '/', deps.issuer).searchParams);
  if (outcome.kind === 'redirect') {
    res.writeHead(302, { location: outcome.location, 'cache-control': 'no-store' }).end();
    return;
  }
  res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(`${outcome.message}\n`);
}

function answerGet(path: string, req: IncomingMessage, res: ServerResponse, deps: OauthDeps): Promise<void> | null {
  if (path === SERVER_PATH) send(res, 200, serverMetadata(deps.issuer), { 'cache-control': 'public, max-age=3600' });
  else if (path === '/oauth/authorize') return authorizeRequest(req, res, deps);
  else if (path.startsWith(RESOURCE_PATH)) send(res, 200, resourceMetadata(deps.issuer, path), { 'cache-control': 'public, max-age=3600' });
  else return null;
  return Promise.resolve();
}

function route(path: string, req: IncomingMessage, res: ServerResponse, deps: OauthDeps): Promise<void> | null {
  if (req.method === 'GET') return answerGet(path, req, res, deps);
  if (req.method !== 'POST') return null;
  if (path === '/oauth/register') return register(req, res, deps);
  return path === '/oauth/token' ? token(req, res, deps) : null;
}

export function handleOauthRequest(req: IncomingMessage, res: ServerResponse, deps: OauthDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (!PATHS.has(path)) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, PREFLIGHT).end();
    return true;
  }
  const work = route(path, req, res, deps);
  if (work === null) {
    send(res, 405, { error: 'method not allowed' });
    return true;
  }
  work.catch((err: unknown) => {
    if (err instanceof ApiError) {
      send(res, err.status, { error: 'invalid_request', error_description: err.message });
      return;
    }
    log.warn({ err: errMsg(err) }, 'mcp: sign-in request failed');
    send(res, 500, { error: 'server_error', error_description: 'mcp.metro.box could not answer. Try again.' });
  });
  return true;
}
