import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { bodyField } from '@metro-labs/http/api-http';
import { connectorAuth, connectorClient, connectorName } from '@metro-labs/http/connector-input';
import { connectorPolicyOf } from '@metro-labs/http/connector-delivery';
import { readConfig } from './config.js';
import type { LocalConnectorRow } from './store.js';
import { agentsDir } from '../agents/files.js';
import { normalizePolicy, type ToolPolicy } from '../policy/policy.js';
import { connectorSyncScope, syncOptedIn, syncSetting } from './org-sync-setting.js';
import { readAgentKey } from './agent-key.js';
import { migrationOrigin } from './migration-url.js';

export type MigrationIssue = 'invalid_config' | 'unsupported_url' | 'custom_policy' | 'oauth_sign_in' | 'header_reentry' | 'unused_oauth_client';

export interface MigrationConnector {
  id: string;
  name: string;
  auth: 'none' | 'header' | 'oauth' | 'invalid';
  origin: string | null;
  policy: ToolPolicy;
  policySupported: boolean;
  issues: MigrationIssue[];
}

export interface ConnectorMigrationPreview {
  migrationSupported: true;
  oauthResourceSupported: true;
  enabled: boolean;
  enrolled: boolean;
  agentId: string | null;
  owner: string | null;
  liveEnabled: boolean;
  connectors: MigrationConnector[];
}

const invalid = (): never => { throw new Error('Invalid local connector configuration.'); };
const onlyKeys = (raw: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(raw).every((key) => keys.includes(key));
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

function optionalStrings(raw: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => raw[key] === undefined || typeof raw[key] === 'string');
}

function validClient(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (!isRecord(raw) || !onlyKeys(raw, ['clientId', 'clientSecret'])) return false;
  if (!nonempty(raw.clientId) || !optionalStrings(raw, ['clientSecret'])) return false;
  const client = connectorClient(raw.clientId, raw.clientSecret);
  return client !== null && client.clientId === raw.clientId && client.clientSecret === raw.clientSecret;
}

function oauthAuth(raw: Record<string, unknown>): 'oauth' {
  if (!onlyKeys(raw, ['kind', 'accessToken', 'refreshToken', 'clientId', 'clientSecret', 'tokenEndpoint', 'issuer', 'scope', 'expiresAt'])) invalid();
  return 'oauth';
}

function headerAuth(raw: Record<string, unknown>): 'header' {
  if (raw.kind !== 'header' || !onlyKeys(raw, ['kind', 'name', 'value'])) return invalid();
  if (!nonempty(raw.name) || !nonempty(raw.value)) return invalid();
  const auth = connectorAuth(raw.name, raw.value);
  return auth.kind === 'header' && auth.name === raw.name && auth.value === raw.value ? 'header' : invalid();
}

function authKind(raw: unknown): Exclude<MigrationConnector['auth'], 'invalid'> {
  if (!isRecord(raw)) return invalid();
  if (raw.kind === 'oauth') return oauthAuth(raw);
  if (raw.kind === 'none' && onlyKeys(raw, ['kind'])) return 'none';
  return headerAuth(raw);
}

function metadataValid(config: Record<string, unknown>): boolean {
  if (!optionalStrings(config, ['createdAt'])) return false;
  const verified = config.verified;
  if (verified !== undefined && (!isRecord(verified) || !optionalStrings(verified, ['at', 'server']))) return false;
  if (config.oauth !== undefined && typeof config.oauth !== 'boolean') return false;
  const groups = config.toolGroups;
  if (groups === undefined) return true;
  if (!isRecord(groups) || Object.keys(groups).length > 1000) return false;
  return Object.entries(groups).every(([name, group]) => name.length > 0 && name.length <= 128 && (group === 'read' || group === 'write'));
}

function configAuth(config: unknown): MigrationConnector['auth'] {
  try {
    if (!isRecord(config) || !onlyKeys(config, ['auth', 'oauth', 'client', 'createdAt', 'verified', 'policy', 'toolGroups'])) return 'invalid';
    if (!metadataValid(config) || !validClient(config.client)) return 'invalid';
    const kind = authKind(config.auth);
    if (kind === 'header' && config.oauth === true) return 'invalid';
    return kind === 'none' && config.oauth === true ? 'oauth' : kind;
  } catch {
    return 'invalid';
  }
}

function policyShape(raw: Record<string, unknown>): boolean {
  if (!onlyKeys(raw, ['read', 'write', 'tools'])) return false;
  for (const key of ['read', 'write']) if (Object.hasOwn(raw, key) && typeof raw[key] !== 'string') return false;
  return raw.tools === undefined || (isRecord(raw.tools) && Object.values(raw.tools).every((value) => typeof value === 'string'));
}

function strictPolicy(raw: unknown): ToolPolicy {
  if (raw === undefined) return {};
  if (!isRecord(raw) || !policyShape(raw)) return invalid();
  const policy = normalizePolicy(raw);
  if (isRecord(raw.tools)) {
    policy.tools = Object.fromEntries(Object.entries(raw.tools).map(([name, value]) => {
      const { read } = normalizePolicy({ read: value });
      if (read === undefined) return invalid();
      return [name, read];
    }));
  }
  return policy;
}

function policyPreview(raw: unknown): Pick<MigrationConnector, 'policy' | 'policySupported'> & { valid: boolean } {
  try {
    const policy = strictPolicy(raw);
    let policySupported = false;
    try {
      connectorPolicyOf(policy);
      policySupported = true;
    } catch {
      policySupported = false;
    }
    return { policy, policySupported, valid: true };
  } catch {
    return { policy: {}, policySupported: false, valid: false };
  }
}

function nameOf(raw: unknown): string | null {
  try {
    return connectorName(raw);
  } catch {
    return null;
  }
}

function rowIdentity(row: Record<string, unknown>, index: number): { id: string; name: string; valid: boolean } {
  const id = parseId(row.id);
  const name = nameOf(row.name);
  return { id: id ?? `invalid-${String(index + 1)}`, name: name ?? `Connector ${String(index + 1)}`, valid: id !== null && name !== null };
}

function authIssues(row: Record<string, unknown>, auth: MigrationConnector['auth']): MigrationIssue[] {
  if (auth === 'oauth') return ['oauth_sign_in'];
  const client = bodyField(row.config, 'client');
  return (auth === 'none' || auth === 'header') && client !== undefined && client !== null ? ['unused_oauth_client'] : [];
}

function previewRow(raw: unknown, index: number): MigrationConnector {
  const row = isRecord(raw) ? raw : {};
  const identity = rowIdentity(row, index);
  const auth = configAuth(row.config);
  const { policy, policySupported, valid } = policyPreview(bodyField(row.config, 'policy'));
  const origin = migrationOrigin(row.url);
  const issues: MigrationIssue[] = [];
  if (!identity.valid || auth === 'invalid' || !valid) issues.push('invalid_config');
  if (origin === null) issues.push('unsupported_url');
  if (valid && !policySupported) issues.push('custom_policy');
  issues.push(...authIssues(row, auth));
  return { id: identity.id, name: identity.name, auth, origin, policy, policySupported, issues };
}

const unavailable = (): ApiError => new ApiError('Local connector configuration cannot be previewed. Restore its file or permissions first.', 503);

function readRows(dir: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(join(dir, 'connectors.json'), 'utf8');
  } catch (err) {
    if (isRecord(err) && err.code === 'ENOENT') return [];
    throw unavailable();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw unavailable();
  }
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.connectors)) throw unavailable();
  return raw.connectors;
}

function previewRows(dir: string): MigrationConnector[] {
  const rows = readRows(dir).map(previewRow);
  const seen = new Map<string, MigrationConnector>();
  for (const row of rows) {
    for (const key of [`id:${row.id}`, `name:${row.name}`]) {
      const prior = seen.get(key);
      if (prior !== undefined) {
        for (const duplicate of [prior, row]) if (!duplicate.issues.includes('invalid_config')) duplicate.issues.push('invalid_config');
      }
      seen.set(key, row);
    }
  }
  return rows;
}

export function migrationSource(id: string, dir = agentsDir()): LocalConnectorRow {
  const source = previewRows(dir).find((row) => row.id === id);
  if (source === undefined) throw new ApiError('The local connector is missing.', 404);
  if (source.issues.some((issue) => issue !== 'oauth_sign_in')) throw new ApiError('This connector cannot be migrated without changing its settings or permissions. Resolve the preview blockers first.', 409);
  const raw = readRows(dir).find((row) => isRecord(row) && row.id === id);
  if (!isRecord(raw) || typeof raw.url !== 'string') throw unavailable();
  return { id, name: source.name, url: raw.url, config: { ...readConfig(raw.config), oauth: source.auth === 'oauth', policy: source.policy } };
}

export function connectorMigrationPreview(owner: string | null, dir = agentsDir()): ConnectorMigrationPreview {
  const enabled = syncOptedIn(dir) && syncSetting(dir, connectorSyncScope(owner, readAgentKey(dir))).enabled;
  const liveEnabled = process.env.METRO_CONNECTORS_LIVE_ENABLED === 'true';
  if (!enabled) return { migrationSupported: true, oauthResourceSupported: true, enabled, enrolled: false, agentId: null, owner, liveEnabled, connectors: [] };
  const enrollment = owner === null ? null : readAgentKey(dir)?.enrollment;
  const agentId = enrollment?.organization === owner ? enrollment?.server ?? null : null;
  return { migrationSupported: true, oauthResourceSupported: true, enabled, enrolled: agentId !== null, agentId, owner, liveEnabled, connectors: previewRows(dir) };
}
