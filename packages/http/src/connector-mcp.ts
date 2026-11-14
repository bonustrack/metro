import { isRecord } from '@metro-labs/core/is-record';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { ApiError } from './api-error.js';
import { whyUnreachable } from './connector-reach.js';
import { ConnectorUnauthorized, refused } from './connector-url.js';

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

interface OAuthAuth extends OAuthTokens {
  kind: 'oauth';
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  resource?: string;
  tokenEndpointAuthMethod?: string;
}

export type ConnectorAuth =
  | { kind: 'none' }
  | { kind: 'header'; name: string; value: string }
  | OAuthAuth;

export interface VerifiedServer {
  server: string;
  title?: string;
  name?: string;
  account?: string;
}

const ACCOUNT_EXTENSION = 'box.metro/account';
const ACCOUNT_RE = /^\P{Cc}{1,320}$/u;
const INFO_MAX = 200;

export function declaredAccount(init: Record<string, unknown>): string | null {
  const capabilities = isRecord(init.capabilities) ? init.capabilities : {};
  const extensions = isRecord(capabilities.extensions) ? capabilities.extensions : {};
  const declared = extensions[ACCOUNT_EXTENSION];
  const id = isRecord(declared) && typeof declared.id === 'string' ? declared.id.trim() : '';
  return ACCOUNT_RE.test(id) ? id : null;
}

const PROBE_TIMEOUT_MS = 10_000;

export const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'metro', version: '0.1.0' } },
};

export function authHeaders(auth: ConnectorAuth): Record<string, string> {
  if (auth.kind === 'header') return { [auth.name]: auth.value };
  if (auth.kind === 'oauth') return { Authorization: `Bearer ${auth.accessToken}` };
  return {};
}

function payloadOf(text: string, contentType: string): string {
  if (!contentType.includes('text/event-stream')) return text;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) if (line.startsWith('data:')) return line.slice(5).trim();
  return '';
}

export function resultOf(text: string, contentType: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payloadOf(text, contentType));
    return isRecord(parsed) && isRecord(parsed.result) ? parsed.result : null;
  } catch {
    return null;
  }
}

export async function mcpPost(
  url: URL,
  auth: ConnectorAuth,
  body: unknown,
  opts: { timeoutMs: number; headers?: Record<string, string>; fetch?: FetchLike },
): Promise<Response> {
  const send = opts.fetch ?? fetch;
  try {
    return await send(url.toString(), {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...authHeaders(auth), ...opts.headers },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw refused(`Metro could not reach ${url.hostname}: ${whyUnreachable(err)}`);
  }
}

const infoText = (value: unknown): string | undefined => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' || !ACCOUNT_RE.test(text) ? undefined : text.slice(0, INFO_MAX);
};

function verifiedOf(url: URL, text: string, contentType: string): VerifiedServer {
  const result = resultOf(text, contentType);
  if (result === null || typeof result.protocolVersion !== 'string') throw refused(`${url.hostname} answered, but it does not speak MCP.`);
  const info = isRecord(result.serverInfo) ? result.serverInfo : {};
  const title = infoText(info.title);
  const name = infoText(info.name);
  const account = declaredAccount(result);
  return {
    server: title ?? name ?? url.hostname,
    ...(title === undefined ? {} : { title }),
    ...(name === undefined ? {} : { name }),
    ...(account === null ? {} : { account }),
  };
}

function refuseStatus(res: Response, url: URL, auth: ConnectorAuth): void {
  if (res.status >= 300 && res.status < 400) throw refused('that url redirects. Use the url it redirects to.');
  if (res.status === 401 || res.status === 403)
    throw new ConnectorUnauthorized(auth.kind === 'none' ? `${url.hostname} requires authorization.` : `${url.hostname} rejected that credential.`, 400);
  if (res.status === 404 || res.status === 405)
    throw refused(`${url.hostname} did not accept an MCP initialize over HTTP POST. If it is a legacy SSE server, Metro cannot verify it yet.`);
  if (!res.ok) throw refused(`${url.hostname} answered ${String(res.status)} instead of an MCP initialize.`);
}

export async function verifyRemoteMcp(url: URL, auth: ConnectorAuth, fetchImpl: FetchLike = fetch): Promise<VerifiedServer> {
  const res = await mcpPost(url, auth, INITIALIZE, { timeoutMs: PROBE_TIMEOUT_MS, fetch: fetchImpl });
  const text = await res.text().catch(() => '');
  refuseStatus(res, url, auth);
  return verifiedOf(url, text, res.headers.get('content-type') ?? '');
}
