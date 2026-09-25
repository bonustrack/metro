import { ApiError } from '@metro-labs/http/api-error';
import { stringOf } from '@metro-labs/http/api-http';
import type {
  ConnectorAuth,
  VerifiedRecord,
  VerifiedServer,
} from './verify.js';
import type { OAuthClient } from './oauth-client.js';
import { isRecord } from '@metro-labs/core/is-record';
import type { ToolGroup } from '@metro-labs/core/stations/types';
import { parsePolicy, type ToolPolicy } from '../policy/policy.js';

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
  policy?: ToolPolicy;
  toolGroups?: Record<string, ToolGroup>;
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
  const header = stringOf(rawHeader).trim();
  const value = stringOf(rawValue).trim();
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
  const clientId = stringOf(rawId).trim();
  const clientSecret = stringOf(rawSecret).trim();
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
  const clientId = stringOf(raw.clientId);
  if (clientId === '') return null;
  const clientSecret = stringOf(raw.clientSecret);
  return { clientId, ...(clientSecret === '' ? {} : { clientSecret }) };
}

function readOAuth(raw: Record<string, unknown>): ConnectorAuth {
  const accessToken = stringOf(raw.accessToken);
  const clientId = stringOf(raw.clientId);
  const tokenEndpoint = stringOf(raw.tokenEndpoint);
  if (accessToken === '' || clientId === '' || tokenEndpoint === '')
    return { kind: 'none' };
  const refreshToken = stringOf(raw.refreshToken);
  const clientSecret = stringOf(raw.clientSecret);
  const scope = stringOf(raw.scope);
  return {
    kind: 'oauth',
    accessToken,
    clientId,
    tokenEndpoint,
    issuer: stringOf(raw.issuer),
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
  const name = stringOf(raw.name);
  const value = stringOf(raw.value);
  if (name === '' || value === '') return { kind: 'none' };
  return { kind: 'header', name, value };
}

function readVerified(raw: unknown): VerifiedRecord {
  const record = isRecord(raw) ? raw : {};
  return { at: stringOf(record.at), server: stringOf(record.server) };
}

const TOOL_NAME_MAX = 128;
const TOOL_GROUPS_MAX = 1000;

function readToolGroups(raw: unknown): Record<string, ToolGroup> | undefined {
  if (!isRecord(raw)) return undefined;
  const kept = Object.entries(raw)
    .filter((entry): entry is [string, ToolGroup] => entry[0].length <= TOOL_NAME_MAX && (entry[1] === 'read' || entry[1] === 'write'))
    .slice(0, TOOL_GROUPS_MAX);
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

export function readConfig(raw: unknown): ConnectorConfig {
  const record = isRecord(raw) ? raw : {};
  const auth = readAuth(record.auth);
  const policy = parsePolicy(record.policy, 'connectors.json');
  const toolGroups = readToolGroups(record.toolGroups);
  return {
    auth,
    createdAt: stringOf(record.createdAt),
    verified: readVerified(record.verified),
    oauth: record.oauth === true || auth.kind === 'oauth',
    client: readClient(record.client),
    ...(policy === undefined || Object.keys(policy).length === 0 ? {} : { policy }),
    ...(toolGroups === undefined ? {} : { toolGroups }),
  };
}

export function signInState(config: ConnectorConfig): ConnectorSignIn {
  if (config.auth.kind === 'oauth') return 'connected';
  return config.oauth ? 'disconnected' : null;
}

export function stamp(server: VerifiedServer): VerifiedRecord {
  return { at: new Date().toISOString(), server: server.server };
}
