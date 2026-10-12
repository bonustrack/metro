import { stringOf } from '@metro-labs/http/api-http';
import type {
  ConnectorAuth,
  VerifiedRecord,
  VerifiedServer,
} from '@metro-labs/http/connector-mcp';
import type { OAuthClient } from '@metro-labs/http/connector-oauth';
import { isRecord } from '@metro-labs/core/is-record';
import type { ToolGroup } from '@metro-labs/core/stations/types';
import { parsePolicy, type ToolPolicy } from '../policy/policy.js';

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
    ...(typeof raw.resource === 'string' ? { resource: raw.resource } : {}),
    ...(typeof raw.tokenEndpointAuthMethod === 'string' ? { tokenEndpointAuthMethod: raw.tokenEndpointAuthMethod } : {}),
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
