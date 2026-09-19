import { builtInDaemon } from '../auth/daemon.js';
import { type Account } from '../auth/account.js';
import { accessToken } from './auth.js';
import { isRecord } from './accounts.js';

export const OPERATOR_EMAIL = 'admin@stage.box';

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
  createdAt: string | null;
}

export interface AgentRow {
  id: string;
  owner: string;
  organizationName: string | null;
  host: string;
  name: string | null;
  slug: string | null;
  addedAt: string | null;
  avatar: string | null;
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
    typeof o.id === 'string' ? [{ id: o.id, name: optional(o.name), slug: optional(o.slug), createdAt: optional(o.createdAt) }] : [],
  );
}

export async function fetchAllAgents(): Promise<AgentRow[]> {
  return rows(await call('/agents'), 'agents').flatMap((a) =>
    typeof a.id === 'string' && typeof a.owner === 'string' && typeof a.host === 'string'
      ? [{ id: a.id, owner: a.owner, organizationName: optional(a.organizationName), host: a.host, name: optional(a.name), slug: optional(a.slug), addedAt: optional(a.addedAt), avatar: optional(a.avatar) }]
      : [],
  );
}
