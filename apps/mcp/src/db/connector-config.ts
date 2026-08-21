import { ApiError } from '../daemon/api-error.js';
import type {
  ConnectorAuth,
  VerifiedRecord,
  VerifiedServer,
} from '../daemon/connector-verify.js';
import { readStoredTools } from '../daemon/connector-tools.js';

const CONNECTOR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const HEADER_VALUE_RE = /^[\x20-\x7e]{1,4096}$/;
const DEFAULT_HEADER = 'Authorization';

export class ConnectorError extends ApiError {}

export type ConnectorSignIn = 'connected' | 'disconnected' | null;

export interface ConnectorConfig {
  auth: ConnectorAuth;
  createdAt: string;
  verified: VerifiedRecord;
  oauth: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function connectorName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!CONNECTOR_NAME_RE.test(name))
    throw new ConnectorError(
      'name must be 2-32 characters of A-Z, a-z, 0-9, - or _, starting with a letter or digit',
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

function readOAuth(raw: Record<string, unknown>): ConnectorAuth {
  const accessToken = text(raw.accessToken);
  const clientId = text(raw.clientId);
  const tokenEndpoint = text(raw.tokenEndpoint);
  if (accessToken === '' || clientId === '' || tokenEndpoint === '')
    return { kind: 'none' };
  const refreshToken = text(raw.refreshToken);
  const clientSecret = text(raw.clientSecret);
  return {
    kind: 'oauth',
    accessToken,
    clientId,
    tokenEndpoint,
    issuer: text(raw.issuer),
    ...(refreshToken === '' ? {} : { refreshToken }),
    ...(clientSecret === '' ? {} : { clientSecret }),
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
