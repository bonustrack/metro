import { captureMigrationIdentity, type MigrationIdentity } from './connector-migration-identity.js';
import { isRecord } from '../read.js';
import { timeoutSignal } from '../platform.js';
import { call, ForbiddenError, NotFoundError } from './client.js';
import { readOrgConnectors } from './org-connectors.js';
import { ACCESS_CHOICES, type Access, type ToolPolicy } from './policy.js';

export type MigrationIssue = 'invalid_config' | 'unsupported_url' | 'custom_policy' | 'oauth_sign_in' | 'header_reentry' | 'unused_oauth_client' | 'oauth_private_resource' | 'oauth_unsupported';

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
  migrationSupported?: boolean;
  oauthResourceSupported?: boolean;
  moveAllSupported?: boolean;
  connectors: MigrationSource[];
}

export interface MigrationPlan {
  preview: MigrationPreview;
  rows: { source: MigrationSource }[];
  organizationChecked: boolean;
}

export const MIGRATION_RESOURCE_UPDATE = 'Update this agent before supplying a public OAuth resource. Older Metro migration uses its original OAuth discovery rules.';
export const MIGRATION_UPDATE = 'Update this agent to a Metro version that supports connector migration, then open this dialog again.';
const ISSUES: readonly MigrationIssue[] = ['invalid_config', 'unsupported_url', 'custom_policy', 'oauth_sign_in', 'header_reentry', 'unused_oauth_client', 'oauth_private_resource', 'oauth_unsupported'];
const unexpected = (): Error => new Error('The agent returned an invalid migration preview. Refresh before continuing.');
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
  return { enabled: value.enabled, enrolled: value.enrolled, liveEnabled: value.liveEnabled, migrationSupported: value.migrationSupported === true, oauthResourceSupported: value.oauthResourceSupported === true, moveAllSupported: value.moveAllSupported === true, agentId: value.agentId, owner: value.owner, connectors: value.connectors.map(sourceOf) };
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

export async function readMigrationPreview(identity: MigrationIdentity, signal: AbortSignal): Promise<MigrationPlan> {
  identity.check();
  let preview: MigrationPreview;
  try {
    preview = previewOf(await call({ method: 'GET', base: `${identity.base}/api/connectors/migration-preview`, checkAccount: identity.check, redirect: 'error', signal }));
  } catch (error) {
    identity.check();
    if (error instanceof NotFoundError) throw new Error(MIGRATION_UPDATE);
    throw error;
  }
  identity.check();
  if (!preview.enabled) return { preview, rows: [], organizationChecked: false };
  if (preview.owner !== identity.owner || (preview.enrolled && identity.agentId !== null && preview.agentId !== identity.agentId)) throw new Error('The preview does not match this organization and agent. Refresh before continuing.');
  const organization = await readOrgConnectors(identity.check, signal);
  identity.check();
  if (!organization.admin) throw new ForbiddenError('Only an organization admin can preview a migration.');
  return { preview, rows: preview.connectors.map((source) => ({ source })), organizationChecked: true };
}

export async function fetchMigrationPreview(): Promise<MigrationPlan> {
  const identity = captureMigrationIdentity();
  try {
    return await readMigrationPreview(identity, timeoutSignal(15_000));
  } finally {
    identity.dispose();
  }
}
