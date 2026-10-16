import { dashboardModel, type DashboardRow, type DashboardState } from '@metro-labs/client/api/dashboard';
import type { AgentRow } from '@metro-labs/client/api/admin';
import type { LatestUsage } from '@metro-labs/client/api/latest-usage';
import type { ServerStatus } from '@metro-labs/client/api/servers';
import { olderThan } from '@metro-labs/client/api/version';
import { namedSegment } from '@metro-labs/client/auth/org-segment';
import { matchesQuery, versionRank, type SortDir, type SortValue } from './admin-table.js';

export type AgentState = 'online' | 'updating' | 'offline' | 'stopped' | 'checking' | 'unchecked';

export interface AdminAgent {
  key: string;
  id: string;
  name: string;
  host: string;
  avatar: string | null;
  organizationId: string;
  organizationName: string;
  href: string | null;
  member: boolean;
  state: AgentState;
  updatingTo: string | null;
  version: string | null;
  needsUpdate: boolean;
  model: string | null;
  modelUsed: number | null;
  modelUsage: string | null;
  cpu: number | null;
  memory: number | null;
  lastSeen: number | null;
}

export interface AgentSources {
  dashboard: DashboardState;
  everyAgent: AgentRow[] | undefined;
  usage: Record<string, Record<string, LatestUsage> | undefined>;
  latest: string | null;
  now: number;
  updating: (host: string, status: ServerStatus) => ServerStatus;
}

export const STATE_WORD: Record<AgentState, string> = {
  online: 'Online',
  updating: 'Updating',
  offline: 'Offline',
  stopped: 'Stopped',
  checking: 'Checking',
  unchecked: 'Not checked',
};

const STATE_OF: Record<ServerStatus['state'], AgentState> = { live: 'online', stopped: 'stopped', offline: 'offline', updating: 'updating' };

const URGENCY: Record<AgentState, number> = { offline: 5, updating: 4, stopped: 3, checking: 2, online: 1, unchecked: 0 };

function probeOf(row: DashboardRow): ServerStatus {
  const { mode } = row;
  const version = mode.data?.version ?? null;
  if (mode.error !== null || mode.data === null) return { state: 'offline', version, owner: null };
  return { state: mode.data.stopped ? 'stopped' : 'live', version, owner: mode.data.owner };
}

function memberState(row: DashboardRow, updating: AgentSources['updating']): { state: AgentState; updatingTo: string | null } {
  if (row.mode.data === null && row.mode.error === null) return { state: 'checking', updatingTo: null };
  const status = updating(row.agent.host, probeOf(row));
  return { state: STATE_OF[status.state], updatingTo: status.updatingTo ?? null };
}

type ModelFacts = Pick<AdminAgent, 'model' | 'modelUsed' | 'modelUsage'>;

function modelOf(row: DashboardRow, now: number): ModelFacts {
  if (row.model.data === null) return { model: null, modelUsed: null, modelUsage: null };
  const view = dashboardModel(row.model.data, now);
  if (view.model === 'Model unavailable') return { model: null, modelUsed: null, modelUsage: null };
  return { model: view.model, modelUsed: view.used, modelUsage: view.usage };
}

const newer = (version: string | null, latest: string | null): boolean => latest !== null && olderThan(version, latest);

const agentName = (agent: { name: string | null; slug: string | null; host: string }): string => agent.name ?? agent.slug ?? agent.host;

const organizationName = (organization: DashboardRow['organization']): string => organization.name ?? organization.slug ?? organization.id;

function resourcesOf(usage: LatestUsage | undefined): { cpu: number | null; memory: number | null } {
  return usage === undefined ? { cpu: null, memory: null } : { cpu: usage.cpu, memory: usage.memory };
}

function memberAgent(row: DashboardRow, sources: AgentSources): AdminAgent {
  const { organization, agent } = row;
  const version = row.mode.data?.version ?? null;
  return {
    key: row.key,
    id: agent.id,
    name: agentName(agent),
    host: agent.host,
    avatar: agent.avatar,
    organizationId: organization.id,
    organizationName: organizationName(organization),
    href: `#/${namedSegment(organization.id, organization.slug)}/${namedSegment(agent.id, agent.slug)}`,
    member: true,
    ...memberState(row, sources.updating),
    version,
    needsUpdate: newer(version, sources.latest),
    ...modelOf(row, sources.now),
    ...resourcesOf(sources.usage[organization.id]?.[agent.id]),
    lastSeen: row.mode.at,
  };
}

function otherAgent(agent: AgentRow, known: boolean): AdminAgent {
  return {
    key: `other:${agent.id}`,
    id: agent.id,
    name: agentName(agent),
    host: agent.host,
    avatar: agent.avatar,
    organizationId: agent.owner,
    organizationName: agent.organizationName ?? agent.owner,
    href: null,
    member: false,
    state: known ? 'unchecked' : 'checking',
    updatingTo: null,
    version: null,
    needsUpdate: false,
    model: null,
    modelUsed: null,
    modelUsage: null,
    cpu: null,
    memory: null,
    lastSeen: null,
  };
}

export function adminAgents(sources: AgentSources): AdminAgent[] {
  const members = sources.dashboard.rows.map((row) => memberAgent(row, sources));
  const seen = new Set(members.map((row) => row.id));
  const known = sources.dashboard.organizations !== null;
  const others = (sources.everyAgent ?? []).filter((agent) => !seen.has(agent.id)).map((agent) => otherAgent(agent, known));
  return [...members, ...others];
}

export interface AgentCounts {
  total: number;
  online: number;
  updating: number;
  offline: number;
  needsUpdate: number;
}

export function agentCounts(rows: readonly AdminAgent[]): AgentCounts {
  const count = (test: (row: AdminAgent) => boolean): number => rows.filter(test).length;
  return {
    total: rows.length,
    online: count((row) => row.state === 'online'),
    updating: count((row) => row.state === 'updating'),
    offline: count((row) => row.state === 'offline'),
    needsUpdate: count((row) => row.needsUpdate),
  };
}

export type StatusFilter = 'all' | AgentState;

export type VersionFilter = { kind: 'all' } | { kind: 'update' } | { kind: 'is'; version: string };

export interface AgentFilters {
  query: string;
  organization: string | null;
  status: StatusFilter;
  version: VersionFilter;
}

export const NO_AGENT_FILTERS: AgentFilters = { query: '', organization: null, status: 'all', version: { kind: 'all' } };

function versionPasses(row: AdminAgent, filter: VersionFilter): boolean {
  if (filter.kind === 'all') return true;
  return filter.kind === 'update' ? row.needsUpdate : row.version === filter.version;
}

export function filterAgents(rows: readonly AdminAgent[], filters: AgentFilters): AdminAgent[] {
  return rows.filter(
    (row) =>
      (filters.organization === null || row.organizationId === filters.organization) &&
      (filters.status === 'all' || row.state === filters.status) &&
      versionPasses(row, filters.version) &&
      matchesQuery(filters.query, [row.name, row.host, row.organizationName, row.model, row.version]),
  );
}

export function organizationChoices(rows: readonly AdminAgent[]): { id: string; name: string }[] {
  const names = new Map(rows.map((row) => [row.organizationId, row.organizationName]));
  return [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export function versionChoices(rows: readonly AdminAgent[]): string[] {
  const versions = new Set(rows.flatMap((row) => (row.version === null ? [] : [row.version])));
  return [...versions].sort((a, b) => (versionRank(b) ?? 0) - (versionRank(a) ?? 0));
}

export type AgentSortKey = 'name' | 'organization' | 'status' | 'model' | 'resources' | 'version' | 'seen';

export const AGENT_SORT_START: Record<AgentSortKey, SortDir> = { name: 'asc', organization: 'asc', status: 'desc', model: 'desc', resources: 'desc', version: 'asc', seen: 'asc' };

const busiest = (row: AdminAgent): number | null => (row.cpu === null && row.memory === null ? null : Math.max(row.cpu ?? 0, row.memory ?? 0));

const SORT_VALUE: Record<AgentSortKey, (row: AdminAgent) => SortValue> = {
  name: (row) => row.name,
  organization: (row) => row.organizationName,
  status: (row) => URGENCY[row.state],
  model: (row) => row.modelUsed,
  resources: busiest,
  version: (row) => versionRank(row.version),
  seen: (row) => row.lastSeen,
};

export const agentSortValue = (row: AdminAgent, key: AgentSortKey): SortValue => SORT_VALUE[key](row);

export const agentTie = (row: AdminAgent): string => `${row.name} ${row.organizationName} ${row.key}`;
