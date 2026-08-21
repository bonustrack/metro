import { ApiError } from './api-error.js';
import { errMsg, log } from './log.js';

export class ConnectorVerifyError extends ApiError {}

export class ConnectorUnauthorized extends ConnectorVerifyError {}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface OAuthAuth extends OAuthTokens {
  kind: 'oauth';
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
}

export type ConnectorAuth =
  | { kind: 'none' }
  | { kind: 'header'; name: string; value: string }
  | OAuthAuth;

export interface VerifiedServer {
  server: string;
  version: string;
  protocol: string;
  tools: number;
}

export interface VerifiedRecord extends VerifiedServer {
  at: string;
}

const PROTOCOL_VERSION = '2025-06-18';
const PROBE_TIMEOUT_MS = 10_000;
const ACCEPT = 'application/json, text/event-stream';

const POLICY_MESSAGE =
  'Metro connects from its own server, so it cannot reach a URL on your machine. localhost and private addresses are not usable as connectors.';

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const PRIVATE_SUFFIX = /(?:^|\.)(?:localhost|local|internal|flycast)$/;

function refused(message: string): ConnectorVerifyError {
  return new ConnectorVerifyError(message, 400);
}

function notMcp(url: URL): ConnectorVerifyError {
  return refused(`${url.hostname} answered, but it does not speak MCP.`);
}

function hostAllowed(host: string): boolean {
  if (host === '' || host.startsWith('[')) return false;
  if (IPV4.test(host) || !host.includes('.')) return false;
  return !PRIVATE_SUFFIX.test(host);
}

export function parseConnectorUrl(raw: unknown): URL {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') throw refused('a connector url is required');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw refused('that is not a valid url');
  }
  if (url.protocol !== 'https:')
    throw refused('a connector url must start with https://');
  if (url.username !== '' || url.password !== '')
    throw refused('a connector url must not carry a user:password');
  if (url.hash !== '')
    throw refused('a connector url must not carry a #fragment');
  if (!hostAllowed(url.hostname.toLowerCase())) throw refused(POLICY_MESSAGE);
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch((err: unknown) => {
    log.debug(
      { err: errMsg(err) },
      'connector-verify: could not discard a response body',
    );
  });
}

function authHeaders(auth: ConnectorAuth): Record<string, string> {
  if (auth.kind === 'header') return { [auth.name]: auth.value };
  if (auth.kind === 'oauth')
    return { authorization: `Bearer ${auth.accessToken}` };
  return {};
}

async function frame(
  url: URL,
  auth: ConnectorAuth,
  extra: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: {
        'content-type': 'application/json',
        accept: ACCEPT,
        ...authHeaders(auth),
        ...extra,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw refused(`Metro could not reach ${url.hostname}.`);
  }
  if (res.status >= 300 && res.status < 400) {
    await discard(res);
    throw refused('that url redirects — use the url it redirects to');
  }
  return res;
}

function sseData(body: string): string {
  for (const line of body.replace(/\r\n/g, '\n').split('\n'))
    if (line.startsWith('data:')) return line.slice(5).trim();
  return '';
}

async function payloadOf(res: Response): Promise<string> {
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text().catch(() => '');
  return contentType.includes('text/event-stream') ? sseData(text) : text;
}

async function resultOrNull(
  res: Response,
): Promise<Record<string, unknown> | null> {
  const payload = await payloadOf(res);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.result)) return null;
  return parsed.result;
}

function initializeBody(): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'metro', version: '0.1.0' },
    },
  };
}

function serverFrom(url: URL, result: Record<string, unknown>): VerifiedServer {
  const protocol = result.protocolVersion;
  if (typeof protocol !== 'string') throw notMcp(url);
  const info = isRecord(result.serverInfo) ? result.serverInfo : {};
  return {
    server: typeof info.name === 'string' ? info.name : url.hostname,
    version: typeof info.version === 'string' ? info.version : '',
    protocol,
    tools: 0,
  };
}

async function initialize(
  url: URL,
  auth: ConnectorAuth,
  signal: AbortSignal,
): Promise<{ session: string | null; server: VerifiedServer }> {
  const res = await frame(url, auth, {}, initializeBody(), signal);
  if (res.status === 401 || res.status === 403) {
    await discard(res);
    throw new ConnectorUnauthorized(
      auth.kind === 'none'
        ? `${url.hostname} requires authorization.`
        : `${url.hostname} rejected that credential.`,
      400,
    );
  }
  if (res.status === 404 || res.status === 405) {
    await discard(res);
    throw refused(
      `${url.hostname} did not accept an MCP initialize over HTTP POST. ` +
        'If it is a legacy SSE server, Metro cannot verify it yet.',
    );
  }
  if (!res.ok) {
    await discard(res);
    throw notMcp(url);
  }
  const result = await resultOrNull(res);
  if (result === null) throw notMcp(url);
  return {
    session: res.headers.get('mcp-session-id'),
    server: serverFrom(url, result),
  };
}

function sessionHeaders(session: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'mcp-protocol-version': PROTOCOL_VERSION,
  };
  if (session !== null && session !== '') headers['mcp-session-id'] = session;
  return headers;
}

async function announce(
  url: URL,
  auth: ConnectorAuth,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<void> {
  const res = await frame(
    url,
    auth,
    headers,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    signal,
  );
  await discard(res);
}

async function countTools(
  url: URL,
  auth: ConnectorAuth,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<number> {
  const res = await frame(
    url,
    auth,
    headers,
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    signal,
  );
  if (!res.ok) {
    await discard(res);
    return 0;
  }
  const tools = (await resultOrNull(res))?.tools;
  return Array.isArray(tools) ? tools.length : 0;
}

async function terminate(
  url: URL,
  auth: ConnectorAuth,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: 'DELETE',
    redirect: 'manual',
    signal,
    headers: { ...authHeaders(auth), ...headers },
  });
  await discard(res);
}

export async function verifyRemoteMcp(
  url: URL,
  auth: ConnectorAuth,
): Promise<VerifiedServer> {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const { session, server } = await initialize(url, auth, signal);
  const headers = sessionHeaders(session);
  await announce(url, auth, headers, signal);
  const tools = await countTools(url, auth, headers, signal);
  await terminate(url, auth, headers, signal).catch((err: unknown) => {
    log.debug(
      { host: url.hostname, err: errMsg(err) },
      'connector-verify: the remote declined to end the session',
    );
  });
  return { ...server, tools };
}
