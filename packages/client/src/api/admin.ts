import { baseFromSegment, builtInDaemon } from '../auth/daemon.js';
import { type Account } from '../auth/account.js';
import { accessToken, scopedOrganizationAccessToken } from './auth.js';
import { callBearer } from './client.js';
import { toLatestUsage, type LatestUsage } from './latest-usage.js';
import { isRecord, pngAvatar } from '../read.js';

const OPERATOR_EMAIL = 'admin@stage.box';

export const isOperator = (account: Account | null): boolean => account?.user.email?.toLowerCase() === OPERATOR_EMAIL;

export type UserStatus = 'approved' | 'waitlist' | 'rejected';

export interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  status: UserStatus | null;
  operator: boolean;
}

export interface OrganizationSummary {
  id: string;
  name: string | null;
  slug: string | null;
  avatar: string | null;
  createdAt: string | null;
}

export interface AgentRow {
  id: string;
  owner: string;
  organizationName: string | null;
  kind: 'box' | 'remote';
  host: string | null;
  name: string | null;
  slug: string | null;
  addedAt: string | null;
  avatar: string | null;
  instanceId: string | null;
}

const adminUrl = (path: string): string => `${builtInDaemon()}/api/admin${path}`;
const optional = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const status = (v: unknown): UserStatus | null => (v === 'approved' || v === 'waitlist' || v === 'rejected' ? v : null);

async function call(path: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
  const bearer = await accessToken();
  if (bearer === null) throw new Error('Log in first.');
  let res: Response;
  try {
    res = await fetch(adminUrl(path), {
      method,
      headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error('Failed to reach Metro.');
  }
  const answer: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(isRecord(answer) && typeof answer.error === 'string' ? answer.error : `Metro returned ${String(res.status)}.`);
  if (!isRecord(answer)) throw new Error('Metro returned an unexpected response.');
  return answer;
}

const rows = (answer: Record<string, unknown>, key: string): Record<string, unknown>[] => {
  const list = answer[key];
  return Array.isArray(list) ? list.filter(isRecord) : [];
};

export async function fetchUsers(): Promise<UserRow[]> {
  return rows(await call('/users'), 'users').flatMap((u) =>
    typeof u.id === 'string'
      ? [
          {
            id: u.id,
            email: optional(u.email),
            name: optional(u.name),
            picture: optional(u.picture),
            createdAt: optional(u.createdAt),
            lastLoginAt: optional(u.lastLoginAt),
            status: status(u.status),
            operator: u.operator === true,
          },
        ]
      : [],
  );
}

export async function setUserStatus(id: string, next: UserStatus): Promise<void> {
  await call(`/users/${encodeURIComponent(id)}/status`, 'POST', { status: next });
}

export async function fetchAllOrganizations(): Promise<OrganizationSummary[]> {
  return rows(await call('/organizations'), 'organizations').flatMap((o) =>
    typeof o.id === 'string' ? [{ id: o.id, name: optional(o.name), slug: optional(o.slug), avatar: pngAvatar(o.avatar), createdAt: optional(o.createdAt) }] : [],
  );
}

const hostOf = (a: Record<string, unknown>): { kind: 'box' | 'remote'; host: string | null } | null => {
  if (a.kind === 'remote') return { kind: 'remote', host: null };
  return typeof a.host === 'string' ? { kind: 'box', host: a.host } : null;
};

export async function fetchAllAgents(): Promise<AgentRow[]> {
  return rows(await call('/agents'), 'agents').flatMap((a) => {
    const place = hostOf(a);
    return typeof a.id === 'string' && typeof a.owner === 'string' && place !== null
      ? [
          {
            id: a.id,
            owner: a.owner,
            organizationName: optional(a.organizationName),
            ...place,
            name: optional(a.name),
            slug: optional(a.slug),
            addedAt: optional(a.addedAt),
            avatar: optional(a.avatar),
            instanceId: optional(a.instanceId),
          },
        ]
      : [];
  });
}

export async function fetchOrganizationUsage(organization: string): Promise<Record<string, LatestUsage>> {
  const token = await scopedOrganizationAccessToken(organization);
  return toLatestUsage(await callBearer({ method: 'GET', base: `${builtInDaemon()}/api/servers/usage` }, token));
}

export async function restartAgentIn(organization: string, host: string): Promise<void> {
  const token = await scopedOrganizationAccessToken(organization);
  await callBearer({ method: 'POST', base: `${baseFromSegment(host)}/api/restart` }, token);
}
