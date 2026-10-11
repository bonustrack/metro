import { accountIdentity, accountScopeIdentity, activeAccount, checkAccountIdentity } from '../auth/account.js';
import { currentServer, daemonBase } from '../auth/daemon.js';
import { isRecord } from '../read.js';
import { timeoutSignal } from '../platform.js';
import { call, ForbiddenError, NotFoundError } from './client.js';
import { fetchOrgConnectors, type OrgConnector } from './org-connectors.js';
import { ACCESS_CHOICES, type Access, type ToolPolicy } from './policy.js';

export type MigrationIssue = 'invalid_config' | 'unsupported_url' | 'custom_policy' | 'oauth_sign_in' | 'header_reentry';

export interface MigrationSource {
  id: string;
  name: string;
  auth: 'none' | 'header' | 'oauth' | 'invalid';
  origin: string | null;
  policy: ToolPolicy;
  policySupported: boolean;
  issues: MigrationIssue[];
}

export interface MigrationPreview {
  enabled: boolean;
  enrolled: boolean;
  agentId: string | null;
  owner: string | null;
  liveEnabled: boolean;
  connectors: MigrationSource[];
}

export interface MigrationConflict {
  id: string;
  name: string;
  kind: 'name' | 'service';
  assigned: boolean;
}

export interface MigrationPlan {
  preview: MigrationPreview;
  rows: { source: MigrationSource; conflicts: MigrationConflict[] }[];
  organizationChecked: boolean;
}

export const MIGRATION_UPDATE = 'Update this agent to a Metro version that supports migration preview.';
const ISSUES: readonly MigrationIssue[] = ['invalid_config', 'unsupported_url', 'custom_policy', 'oauth_sign_in', 'header_reentry'];
const unexpected = (): Error => new Error('The agent returned an invalid migration preview. Nothing was changed.');
const access = (value: unknown): value is Access => ACCESS_CHOICES.some((item) => item === value);
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

function policyOf(value: unknown): ToolPolicy {
  if (!isRecord(value) || Object.keys(value).some((key) => !['read', 'write', 'tools'].includes(key))) throw unexpected();
  const policy: ToolPolicy = {};
  for (const key of ['read', 'write'] as const) {
    if (value[key] === undefined) continue;
    if (!access(value[key])) throw unexpected();
    policy[key] = value[key];
  }
  if (value.tools !== undefined) {
    if (!isRecord(value.tools)) throw unexpected();
    const tools: [string, Access][] = [];
    for (const [name, rule] of Object.entries(value.tools)) {
      if (!access(rule)) throw unexpected();
      tools.push([name, rule]);
    }
    policy.tools = Object.fromEntries(tools);
  }
  return policy;
}

function sourceOf(value: unknown): MigrationSource {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.policySupported !== 'boolean' || !nullableString(value.origin)) throw unexpected();
  const auth = (['none', 'header', 'oauth', 'invalid'] as const).find((kind) => kind === value.auth);
  if (auth === undefined) throw unexpected();
  if (value.origin !== null && originOf(value.origin) !== value.origin) throw unexpected();
  if (!Array.isArray(value.issues)) throw unexpected();
  const issues = value.issues.map((issue: unknown) => {
    const known = ISSUES.find((item) => item === issue);
    if (known === undefined) throw unexpected();
    return known;
  });
  return { id: value.id, name: value.name, auth, origin: value.origin, policy: policyOf(value.policy), policySupported: value.policySupported, issues };
}

function previewOf(value: unknown): MigrationPreview {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || typeof value.enrolled !== 'boolean' || typeof value.liveEnabled !== 'boolean' || !nullableString(value.agentId) || !nullableString(value.owner) || !Array.isArray(value.connectors)) throw unexpected();
  if (!value.enabled && value.connectors.length !== 0) throw unexpected();
  return { enabled: value.enabled, enrolled: value.enrolled, liveEnabled: value.liveEnabled, agentId: value.agentId, owner: value.owner, connectors: value.connectors.map(sourceOf) };
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

function conflictsFor(source: MigrationSource, connectors: OrgConnector[], agentId: string | null): MigrationConflict[] {
  return connectors.flatMap((row) => {
    const sameName = row.name.trim().toLowerCase() === source.name.trim().toLowerCase();
    const sameService = source.origin !== null && source.origin === originOf(row.url);
    if (!sameName && !sameService) return [];
    return [{ id: row.id, name: row.name, kind: sameName ? 'name' : 'service', assigned: agentId !== null && row.agents.some((agent) => agent.id === agentId) }];
  });
}

function scopeCheck(): () => void {
  const identity = accountIdentity();
  const scope = accountScopeIdentity();
  const base = daemonBase();
  const server = currentServer()?.id;
  return () => {
    checkAccountIdentity(identity);
    if (scope !== accountScopeIdentity() || base !== daemonBase() || server !== currentServer()?.id) throw new Error('The account or agent changed. Open a new preview.');
    if (activeAccount()?.role !== 'admin') throw new ForbiddenError('Only an organization admin can preview a migration.');
  };
}

function checkSource(preview: MigrationPreview): void {
  if (preview.owner !== activeAccount()?.organization || (preview.enrolled && currentServer() !== null && preview.agentId !== currentServer()?.id)) throw new Error('The preview does not match this organization and agent. Nothing was changed.');
}

export async function fetchMigrationPreview(): Promise<MigrationPlan> {
  const checkAccount = scopeCheck();
  checkAccount();
  let preview: MigrationPreview;
  try {
    preview = previewOf(await call({ method: 'GET', base: `${daemonBase()}/api/connectors/migration-preview`, checkAccount, redirect: 'error', signal: timeoutSignal(15_000) }));
  } catch (error) {
    if (error instanceof NotFoundError) throw new Error(MIGRATION_UPDATE);
    throw error;
  }
  if (!preview.enabled) return { preview, rows: [], organizationChecked: false };
  checkSource(preview);
  const organization = await fetchOrgConnectors();
  checkAccount();
  if (!organization.admin) throw new ForbiddenError('Only an organization admin can preview a migration.');
  return { preview, rows: preview.connectors.map((source) => ({ source, conflicts: conflictsFor(source, organization.connectors, preview.agentId) })), organizationChecked: true };
}
