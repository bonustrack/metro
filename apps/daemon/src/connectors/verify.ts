import { isRecord } from '@metro-labs/core/is-record';
import { whyUnreachable } from './reach.js';
import { ConnectorUnauthorized, refused } from './url.js';

export {
  ConnectorUnauthorized,
  ConnectorVerifyError,
  connectorUrlText,
  parseConnectorUrl,
} from './url.js';

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
  scope?: string;
}

export type ConnectorAuth =
  | { kind: 'none' }
  | { kind: 'header'; name: string; value: string }
  | OAuthAuth;

export interface VerifiedServer {
  server: string;
}

export interface VerifiedRecord extends VerifiedServer {
  at: string;
}

const PROTOCOL_VERSION = '2025-11-25';
const PROBE_TIMEOUT_MS = 10_000;

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'metro', version: '0.1.0' } },
};

export function authHeaders(auth: ConnectorAuth): Record<string, string> {
  if (auth.kind === 'header') return { [auth.name]: auth.value };
  if (auth.kind === 'oauth') return { authorization: `Bearer ${auth.accessToken}` };
  return {};
}

function payloadOf(text: string, contentType: string): string {
  if (!contentType.includes('text/event-stream')) return text;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) if (line.startsWith('data:')) return line.slice(5).trim();
  return '';
}

function serverNameOf(url: URL, text: string, contentType: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadOf(text, contentType));
  } catch {
    throw refused(`${url.hostname} answered, but it does not speak MCP.`);
  }
  const result = isRecord(parsed) && isRecord(parsed.result) ? parsed.result : null;
  if (result === null || typeof result.protocolVersion !== 'string') throw refused(`${url.hostname} answered, but it does not speak MCP.`);
  const info = isRecord(result.serverInfo) ? result.serverInfo : {};
  const title = typeof info.title === 'string' ? info.title : '';
  if (title !== '') return title;
  return typeof info.name === 'string' ? info.name : url.hostname;
}

async function post(url: URL, auth: ConnectorAuth): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...authHeaders(auth) },
      body: JSON.stringify(INITIALIZE),
    });
  } catch (err) {
    throw refused(`Metro could not reach ${url.hostname}: ${whyUnreachable(err)}`);
  }
}

export async function verifyRemoteMcp(url: URL, auth: ConnectorAuth): Promise<VerifiedServer> {
  const res = await post(url, auth);
  const text = await res.text().catch(() => '');
  if (res.status >= 300 && res.status < 400) throw refused('that url redirects — use the url it redirects to');
  if (res.status === 401 || res.status === 403)
    throw new ConnectorUnauthorized(auth.kind === 'none' ? `${url.hostname} requires authorization.` : `${url.hostname} rejected that credential.`, 400);
  if (res.status === 404 || res.status === 405)
    throw refused(`${url.hostname} did not accept an MCP initialize over HTTP POST. If it is a legacy SSE server, Metro cannot verify it yet.`);
  if (!res.ok) throw refused(`${url.hostname} answered ${String(res.status)} instead of an MCP initialize.`);
  return { server: serverNameOf(url, text, res.headers.get('content-type') ?? '') };
}
