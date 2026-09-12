import { ApiError } from '@metro-labs/http/api-error';
import type {
  ConnectorAuth,
  VerifiedRecord,
  VerifiedServer,
} from './verify.js';
import { readStoredTools } from './tools.js';
import type { OAuthClient } from './oauth-client.js';
import { isRecord } from '@metro-labs/core/is-record';

const CONNECTOR_NAME_MAX = 64;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const HEADER_VALUE_RE = /^[\x20-\x7e]{1,4096}$/;
const CLIENT_ID_RE = /^[\x21-\x7e]{1,256}$/;
const CLIENT_SECRET_RE = /^[\x21-\x7e]{1,1024}$/;
const DEFAULT_HEADER = 'Authorization';

export class ConnectorError extends ApiError {}

export type ConnectorSignIn = 'connected' | 'disconnected' | null;

export interface ConnectorConfig {
  auth: ConnectorAuth;
  createdAt: string;
  verified: VerifiedRecord;
  oauth: boolean;
  client: OAuthClient | null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function connectorName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') throw new ConnectorError('a connector needs a name', 400);
  if (name.length > CONNECTOR_NAME_MAX)
    throw new ConnectorError(
      `a connector name must be ${String(CONNECTOR_NAME_MAX)} characters or fewer`,
      400,
    );
  if (hasControlChar(name))
    throw new ConnectorError(
      'a connector name must not contain control characters',
      400,
    );
  return name;
}

export function connectorAuth(
  rawHeader: unknown,
  rawValue: unknown,
): ConnectorAuth {
  const header = text(rawHeader).trim();
  const value = text(rawValue).trim();
  if (header === '' && value === '') return { kind: 'none' };
  if (value === '')
    throw new ConnectorError(
      'that header has no value — give both a header name and its value, or neither',
      400,
    );
  const name = header === '' ? DEFAULT_HEADER : header;
  if (!HEADER_NAME_RE.test(name))
    throw new ConnectorError('that is not a valid HTTP header name', 400);
  if (!HEADER_VALUE_RE.test(value))
    throw new ConnectorError('that header value is not sendable', 400);
  return { kind: 'header', name, value };
}

export function connectorClient(
  rawId: unknown,
  rawSecret: unknown,
): OAuthClient | null {
  const clientId = text(rawId).trim();
  const clientSecret = text(rawSecret).trim();
  if (clientId === '' && clientSecret === '') return null;
  if (clientId === '')
    throw new ConnectorError('a client secret needs the client ID it belongs to', 400);
  if (!CLIENT_ID_RE.test(clientId))
    throw new ConnectorError('that is not a client ID Metro can send', 400);
  if (clientSecret !== '' && !CLIENT_SECRET_RE.test(clientSecret))
    throw new ConnectorError('that client secret is not sendable', 400);
  return { clientId, ...(clientSecret === '' ? {} : { clientSecret }) };
}

function readClient(raw: unknown): OAuthClient | null {
  if (!isRecord(raw)) return null;
  const clientId = text(raw.clientId);
  if (clientId === '') return null;
  const clientSecret = text(raw.clientSecret);
  return { clientId, ...(clientSecret === '' ? {} : { clientSecret }) };
}

function readOAuth(raw: Record<string, unknown>): ConnectorAuth {
  const accessToken = text(raw.accessToken);
  const clientId = text(raw.clientId);
  const tokenEndpoint = text(raw.tokenEndpoint);
  if (accessToken === '' || clientId === '' || tokenEndpoint === '')
    return { kind: 'none' };
  const refreshToken = text(raw.refreshToken);
  const clientSecret = text(raw.clientSecret);
  const scope = text(raw.scope);
  return {
    kind: 'oauth',
    accessToken,
    clientId,
    tokenEndpoint,
    issuer: text(raw.issuer),
    ...(refreshToken === '' ? {} : { refreshToken }),
    ...(clientSecret === '' ? {} : { clientSecret }),
    ...(scope === '' ? {} : { scope }),
    ...(typeof raw.expiresAt === 'number' ? { expiresAt: raw.expiresAt } : {}),
  };
}

function readAuth(raw: unknown): ConnectorAuth {
  if (!isRecord(raw)) return { kind: 'none' };
  if (raw.kind === 'oauth') return readOAuth(raw);
  if (raw.kind !== 'header') return { kind: 'none' };
  const name = text(raw.name);
  const value = text(raw.value);
  if (name === '' || value === '') return { kind: 'none' };
  return { kind: 'header', name, value };
}

function readVerified(raw: unknown): VerifiedRecord {
  const record = isRecord(raw) ? raw : {};
  const catalog = readStoredTools(record.catalog);
  return {
    at: text(record.at),
    server: text(record.server),
    version: text(record.version),
    protocol: text(record.protocol),
    icon: text(record.icon),
    tools: typeof record.tools === 'number' ? record.tools : 0,
    catalog,
  };
}

export function readConfig(raw: unknown): ConnectorConfig {
  const record = isRecord(raw) ? raw : {};
  const auth = readAuth(record.auth);
  return {
    auth,
    createdAt: text(record.createdAt),
    verified: readVerified(record.verified),
    oauth: record.oauth === true || auth.kind === 'oauth',
    client: readClient(record.client),
  };
}

export function signInState(config: ConnectorConfig): ConnectorSignIn {
  if (config.auth.kind === 'oauth') return 'connected';
  return config.oauth ? 'disconnected' : null;
}

export function stamp(server: VerifiedServer): VerifiedRecord {
  return {
    at: new Date().toISOString(),
    server: server.server,
    version: server.version,
    protocol: server.protocol,
    icon: server.icon,
    tools: server.tools,
    catalog: server.catalog,
  };
}
