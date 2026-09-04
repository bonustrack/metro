import { errMsg, log } from './log.js';
import {
  ConnectorNotMcp,
  ConnectorUnauthorized,
  refused,
  safeIconSrc,
} from './connector-url.js';
import { toToolList, type ToolInfo } from './connector-tools.js';

export {
  ConnectorUnauthorized,
  ConnectorVerifyError,
  connectorUrlText,
  parseConnectorUrl,
} from './connector-url.js';
import { isRecord } from './is-record.js';

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
  icon: string;
  tools: number;
  catalog: ToolInfo[];
}

export interface VerifiedRecord extends VerifiedServer {
  at: string;
}

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18'] as const;
const MAX_TOOL_PAGES = 10;

function notMcp(url: URL): ConnectorNotMcp {
  return new ConnectorNotMcp(
    `${url.hostname} answered, but it does not speak MCP.`,
    400,
  );
}
const PROBE_TIMEOUT_MS = 10_000;
const ACCEPT = 'application/json, text/event-stream';

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

function initializeBody(version: string): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: 'metro', version: '0.1.0' },
    },
  };
}

function iconOf(info: Record<string, unknown>): string {
  const icons = info.icons;
  if (!Array.isArray(icons)) return '';
  for (const entry of icons) {
    if (!isRecord(entry)) continue;
    const src = safeIconSrc(entry.src);
    if (src !== '') return src;
  }
  return '';
}

function serverFrom(url: URL, result: Record<string, unknown>): VerifiedServer {
  const protocol = result.protocolVersion;
  if (typeof protocol !== 'string') throw notMcp(url);
  const info = isRecord(result.serverInfo) ? result.serverInfo : {};
  const title = typeof info.title === 'string' ? info.title : '';
  return {
    server:
      title !== ''
        ? title
        : typeof info.name === 'string'
          ? info.name
          : url.hostname,
    version: typeof info.version === 'string' ? info.version : '',
    protocol,
    icon: iconOf(info),
    tools: 0,
    catalog: [],
  };
}

async function initialize(
  url: URL,
  auth: ConnectorAuth,
  signal: AbortSignal,
  version: string,
): Promise<{ session: string | null; server: VerifiedServer }> {
  const res = await frame(url, auth, {}, initializeBody(version), signal);
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

function sessionHeaders(
  session: string | null,
  version: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'mcp-protocol-version': version,
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

async function toolPage(
  url: URL,
  auth: ConnectorAuth,
  headers: Record<string, string>,
  signal: AbortSignal,
  cursor: string,
): Promise<Record<string, unknown> | null> {
  const params = cursor === '' ? {} : { cursor };
  const res = await frame(
    url,
    auth,
    headers,
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params },
    signal,
  );
  if (!res.ok) {
    await discard(res);
    return null;
  }
  return resultOrNull(res);
}

async function listTools(
  url: URL,
  auth: ConnectorAuth,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<ToolInfo[]> {
  const tools: ToolInfo[] = [];
  let cursor = '';
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const result = await toolPage(url, auth, headers, signal, cursor);
    if (result === null) break;
    tools.push(...toToolList(result.tools));
    const next = result.nextCursor;
    if (typeof next !== 'string' || next === '' || next === cursor) break;
    cursor = next;
  }
  return tools;
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

async function probeWith(
  url: URL,
  auth: ConnectorAuth,
  version: string,
): Promise<VerifiedServer> {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const { session, server } = await initialize(url, auth, signal, version);
  const headers = sessionHeaders(session, server.protocol);
  await announce(url, auth, headers, signal);
  const catalog = await listTools(url, auth, headers, signal);
  await terminate(url, auth, headers, signal).catch((err: unknown) => {
    log.debug(
      { host: url.hostname, err: errMsg(err) },
      'connector-verify: the remote declined to end the session',
    );
  });
  return { ...server, tools: catalog.length, catalog };
}

export async function verifyRemoteMcp(
  url: URL,
  auth: ConnectorAuth,
): Promise<VerifiedServer> {
  let last: unknown;
  for (const version of PROTOCOL_VERSIONS) {
    try {
      return await probeWith(url, auth, version);
    } catch (err) {
      if (!(err instanceof ConnectorNotMcp)) throw err;
      last = err;
    }
  }
  throw last;
}
