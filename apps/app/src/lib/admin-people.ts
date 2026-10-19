import type { AgentRow, OrganizationSummary, UserRow, UserStatus } from '@metro-labs/client/api/admin';
import type { OrganizationRow } from '@metro-labs/client/api/auth';
import type { AdminAgent } from './admin-agents.js';
import { matchesQuery, timeOf, type SortDir, type SortValue } from './admin-table.js';

const WEEK_MS = 7 * 24 * 60 * 60_000;

export type UserState = UserStatus | 'none';

export const userState = (user: UserRow): UserState => user.status ?? 'none';

export const USER_STATE_WORD: Record<UserState, string> = { approved: 'Approved', waitlist: 'Waiting', rejected: 'Blocked', none: 'Not approved' };

const USER_URGENCY: Record<UserState, number> = { waitlist: 3, none: 2, rejected: 1, approved: 0 };

export const userName = (user: UserRow): string => user.name ?? user.email ?? user.id;

export interface UserCounts {
  total: number;
  waiting: number;
  week: number;
  blocked: number;
}

const withinWeek = (iso: string | null, now: number): boolean => {
  const at = timeOf(iso);
  return at !== null && now - at < WEEK_MS;
};

export function userCounts(users: readonly UserRow[], now: number): UserCounts {
  return {
    total: users.length,
    waiting: users.filter((user) => user.status === 'waitlist').length,
    week: users.filter((user) => withinWeek(user.lastLoginAt, now)).length,
    blocked: users.filter((user) => user.status === 'rejected').length,
  };
}

export interface UserFilters {
  query: string;
  status: 'all' | UserState;
}

export const NO_USER_FILTERS: UserFilters = { query: '', status: 'all' };

export function filterUsers(users: readonly UserRow[], filters: UserFilters): UserRow[] {
  return users.filter((user) => (filters.status === 'all' || userState(user) === filters.status) && matchesQuery(filters.query, [user.name, user.email]));
}

export type UserSortKey = 'name' | 'status' | 'created' | 'seen';

export const USER_SORT_START: Record<UserSortKey, SortDir> = { name: 'asc', status: 'desc', created: 'desc', seen: 'desc' };

const USER_VALUE: Record<UserSortKey, (user: UserRow) => SortValue> = {
  name: userName,
  status: (user) => USER_URGENCY[userState(user)],
  created: (user) => timeOf(user.createdAt),
  seen: (user) => timeOf(user.lastLoginAt),
};

export const userSortValue = (user: UserRow, key: UserSortKey): SortValue => USER_VALUE[key](user);

export const userTie = (user: UserRow): string => `${userName(user)} ${user.id}`;

export interface AdminOrganization {
  id: string;
  name: string;
  slug: string | null;
  avatar: string | null;
  createdAt: number | null;
  agents: number;
  online: number | null;
  role: string | null;
  member: boolean;
}

export const ROLE_WORD: Record<string, string> = { admin: 'Admin', member: 'Member' };

export const roleWord = (organization: AdminOrganization): string => (organization.member ? (ROLE_WORD[organization.role ?? ''] ?? 'Member') : 'Not a member');

function onlineIn(id: string, live: readonly AdminAgent[]): number {
  return live.filter((agent) => agent.organizationId === id && agent.state === 'online').length;
}

export function adminOrganizations(organizations: readonly OrganizationSummary[], agents: readonly AgentRow[], mine: readonly OrganizationRow[] | null, live: readonly AdminAgent[]): AdminOrganization[] {
  const roles = new Map((mine ?? []).map((row) => [row.id, row.role]));
  return organizations.map((organization) => ({
    id: organization.id,
    name: organization.name ?? organization.slug ?? organization.id,
    slug: organization.slug,
    avatar: organization.avatar,
    createdAt: timeOf(organization.createdAt),
    agents: agents.filter((agent) => agent.owner === organization.id).length,
    online: roles.has(organization.id) ? onlineIn(organization.id, live) : null,
    role: roles.get(organization.id) ?? null,
    member: roles.has(organization.id),
  }));
}

export interface OrganizationCounts {
  total: number;
  agents: number;
  member: number;
  empty: number;
}

export function organizationCounts(rows: readonly AdminOrganization[]): OrganizationCounts {
  return {
    total: rows.length,
    agents: rows.reduce((sum, row) => sum + row.agents, 0),
    member: rows.filter((row) => row.member).length,
    empty: rows.filter((row) => row.agents === 0).length,
  };
}

export const filterOrganizations = (rows: readonly AdminOrganization[], query: string): AdminOrganization[] =>
  rows.filter((row) => matchesQuery(query, [row.name, row.slug, row.id]));

export type OrganizationSortKey = 'name' | 'agents' | 'role' | 'created';

export const ORGANIZATION_SORT_START: Record<OrganizationSortKey, SortDir> = { name: 'asc', agents: 'desc', role: 'asc', created: 'desc' };

const ORGANIZATION_VALUE: Record<OrganizationSortKey, (row: AdminOrganization) => SortValue> = {
  name: (row) => row.name,
  agents: (row) => row.agents,
  role: roleWord,
  created: (row) => row.createdAt,
};

export const organizationSortValue = (row: AdminOrganization, key: OrganizationSortKey): SortValue => ORGANIZATION_VALUE[key](row);

export const organizationTie = (row: AdminOrganization): string => `${row.name} ${row.id}`;
