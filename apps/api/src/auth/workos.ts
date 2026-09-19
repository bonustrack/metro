import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { filled, workosBase } from '@metro-labs/http/workos-token';

export const PROVIDERS = { google: 'GoogleOAuth', microsoft: 'MicrosoftOAuth', github: 'GitHubOAuth' } as const;
export type Provider = keyof typeof PROVIDERS;
const FETCH_MS = 15_000;

export interface WorkosConfig {
  apiKey: string;
  clientId: string;
  base: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  organization: string | null;
  user: { id: string; email: string | null; name: string | null; picture: string | null; createdAt: string | null };
}

export class WorkosError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number,
  ) {
    super(message);
  }
}

export const ALL_PROVIDERS: Provider[] = ['google', 'microsoft', 'github'];
export const isProvider = (value: unknown): value is Provider => typeof value === 'string' && (ALL_PROVIDERS as string[]).includes(value);
const PROBE_MS = 60_000;
const PROBE_FETCH_MS = 5_000;

export async function providerEnabled(cfg: WorkosConfig, provider: Provider, redirectUri: string): Promise<boolean | null> {
  try {
    const res = await fetch(authorizationUrl(cfg, provider, redirectUri, 'probe'), { redirect: 'manual', signal: AbortSignal.timeout(PROBE_FETCH_MS) });
    if (res.status >= 300 && res.status < 400) return true;
    return res.status === 404 ? false : null;
  } catch {
    return null;
  }
}

let probed: { at: number; providers: Provider[] } | null = null;
let probing: Promise<Provider[]> | null = null;

async function probeProviders(cfg: WorkosConfig, redirectUri: string, now: number): Promise<Provider[]> {
  const before = probed?.providers ?? [];
  const answers = await Promise.all(ALL_PROVIDERS.map((p) => providerEnabled(cfg, p, redirectUri)));
  const providers = ALL_PROVIDERS.filter((p, i) => answers[i] === true || (answers[i] === null && before.includes(p)));
  if (answers.every((a) => a === null)) {
    log.warn('auth: WorkOS did not answer the provider probe, keeping the last list');
    return before;
  }
  probed = { at: now, providers };
  return providers;
}

export function enabledProviders(cfg: WorkosConfig, redirectUri: string, now = Date.now()): Promise<Provider[]> {
  if (probed !== null && now - probed.at < PROBE_MS) return Promise.resolve(probed.providers);
  probing ??= probeProviders(cfg, redirectUri, now).finally(() => {
    probing = null;
  });
  if (probed === null) return probing;
  probing.catch(() => undefined);
  return Promise.resolve(probed.providers);
}

export function forgetProviders(): void {
  probed = null;
}

export function readWorkosConfig(env: NodeJS.ProcessEnv = process.env): WorkosConfig | null {
  const apiKey = filled(env.WORKOS_API_KEY);
  const clientId = filled(env.WORKOS_CLIENT_ID);
  if (apiKey === null || clientId === null) return null;
  return { apiKey, clientId, base: workosBase(env) };
}

export function authorizationUrl(cfg: WorkosConfig, provider: Provider, redirectUri: string, state: string): string {
  const url = new URL(`${cfg.base}/user_management/authorize`);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('provider', PROVIDERS[provider]);
  url.searchParams.set('state', state);
  return url.toString();
}

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function tokensOf(body: unknown): Tokens {
  if (!isRecord(body) || !isRecord(body.user)) throw new WorkosError('WorkOS answered without a user', null, 502);
  const accessToken = str(body.access_token);
  const refreshToken = str(body.refresh_token);
  const id = str(body.user.id);
  if (accessToken === null || refreshToken === null || id === null) throw new WorkosError('WorkOS answered without tokens', null, 502);
  const first = str(body.user.first_name);
  const last = str(body.user.last_name);
  const name = [first, last].filter((p) => p !== null).join(' ');
  return {
    accessToken,
    refreshToken,
    organization: str(body.organization_id),
    user: { id, email: str(body.user.email), name: name === '' ? null : name, picture: str(body.user.profile_picture_url), createdAt: str(body.user.created_at) },
  };
}

const SELECTION_GRANT = 'urn:workos:oauth:grant-type:organization-selection';

function pendingSelection(body: Record<string, unknown>): { pending: string; organization: string } | null {
  if (str(body.code) !== 'organization_selection_required') return null;
  const pending = str(body.pending_authentication_token);
  const listed: unknown[] = Array.isArray(body.organizations) ? (body.organizations as unknown[]) : [];
  const first = listed[0] ?? null;
  const organization = isRecord(first) ? str(first.id) : null;
  return pending === null || organization === null ? null : { pending, organization };
}

function refusedAuthentication(body: Record<string, unknown>, status: number): WorkosError {
  const code = str(body.code) ?? str(body.error);
  const message = str(body.message) ?? str(body.error_description);
  return new WorkosError(message ?? `WorkOS answered ${String(status)}`, code, status === 400 || status === 401 ? 401 : 502);
}

async function authenticate(cfg: WorkosConfig, grant: Record<string, string>, selecting = false): Promise<Tokens> {
  const res = await fetch(`${cfg.base}/user_management/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.apiKey, ...grant }),
    signal: AbortSignal.timeout(FETCH_MS),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const answer = isRecord(body) ? body : {};
    const selection = selecting ? null : pendingSelection(answer);
    if (selection === null) throw refusedAuthentication(answer, res.status);
    log.info({ organization: selection.organization }, 'auth: WorkOS asked for an organization, taking the first one listed');
    return authenticate(cfg, { grant_type: SELECTION_GRANT, pending_authentication_token: selection.pending, organization_id: selection.organization }, true);
  }
  return tokensOf(body);
}

export const exchangeCode = (cfg: WorkosConfig, code: string): Promise<Tokens> => authenticate(cfg, { grant_type: 'authorization_code', code });

export const refreshTokens = (cfg: WorkosConfig, refreshToken: string, organization?: string): Promise<Tokens> =>
  authenticate(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken, ...(organization === undefined ? {} : { organization_id: organization }) });

async function request(cfg: WorkosConfig, method: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${cfg.base}${path}`, {
    method,
    headers: { authorization: `Bearer ${cfg.apiKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(FETCH_MS),
  });
  const answer: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = isRecord(answer) ? str(answer.message) : null;
    throw new WorkosError(message ?? `WorkOS answered ${String(res.status)} on ${path}`, isRecord(answer) ? str(answer.code) : null, res.status === 422 || res.status === 400 ? 400 : 502);
  }
  return isRecord(answer) ? answer : {};
}

const api = (cfg: WorkosConfig, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => request(cfg, 'POST', path, body);

const rows = (answer: Record<string, unknown>): Record<string, unknown>[] => (Array.isArray(answer.data) ? answer.data.filter(isRecord) : []);

export interface Member {
  membershipId: string;
  userId: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  role: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: string | null;
  expiresAt: string | null;
}

export type Role = 'admin' | 'member';
export const isRole = (value: unknown): value is Role => value === 'admin' || value === 'member';

const LIST = 'limit=100';

export async function listMembers(cfg: WorkosConfig, organization: string): Promise<Member[]> {
  const [users, memberships] = await Promise.all([
    request(cfg, 'GET', `/user_management/users?organization_id=${organization}&${LIST}`),
    request(cfg, 'GET', `/user_management/organization_memberships?organization_id=${organization}&statuses=active&${LIST}`),
  ]);
  const people = new Map(rows(users).map((u) => [str(u.id) ?? '', u]));
  return rows(memberships).flatMap((m) => {
    const member = memberOf(m, people);
    return member === null ? [] : [member];
  });
}

function memberOf(m: Record<string, unknown>, people: Map<string, Record<string, unknown>>): Member | null {
  const membershipId = str(m.id);
  const userId = str(m.user_id);
  if (membershipId === null || userId === null) return null;
  const person = people.get(userId) ?? {};
  const name = [str(person.first_name), str(person.last_name)].filter((p) => p !== null).join(' ');
  return {
    membershipId,
    userId,
    email: str(person.email),
    name: name === '' ? null : name,
    picture: str(person.profile_picture_url),
    role: (isRecord(m.role) ? str(m.role.slug) : null) ?? 'member',
  };
}

export async function listInvitations(cfg: WorkosConfig, organization: string): Promise<Invitation[]> {
  const answer = await request(cfg, 'GET', `/user_management/invitations?organization_id=${organization}&${LIST}`);
  return rows(answer)
    .filter((i) => i.state === 'pending')
    .flatMap((i) => {
      const id = str(i.id);
      const email = str(i.email);
      return id === null || email === null ? [] : [{ id, email, role: str(i.role_slug), expiresAt: str(i.expires_at) }];
    });
}

export async function sendInvitation(cfg: WorkosConfig, organization: string, email: string, role: Role, inviter: string): Promise<Invitation> {
  const made = await api(cfg, '/user_management/invitations', { email, organization_id: organization, role_slug: role, inviter_user_id: inviter });
  return { id: str(made.id) ?? '', email, role, expiresAt: str(made.expires_at) };
}

export const revokeInvitation = (cfg: WorkosConfig, id: string): Promise<unknown> => api(cfg, `/user_management/invitations/${id}/revoke`, {});

export const setMembershipRole = (cfg: WorkosConfig, id: string, role: Role): Promise<unknown> =>
  request(cfg, 'PUT', `/user_management/organization_memberships/${id}`, { role_slug: role });

export const removeMembership = (cfg: WorkosConfig, id: string): Promise<unknown> => request(cfg, 'DELETE', `/user_management/organization_memberships/${id}`);

export const ORGANIZATION_NAME_RE = /^[^\p{Cc}]{2,64}$/u;

const names = new Map<string, string>();

export function rememberOrganizationName(id: string, name: string): void {
  names.set(id, name);
}

export async function organizationName(cfg: WorkosConfig, id: string): Promise<string | null> {
  const held = names.get(id);
  if (held !== undefined) return held;
  try {
    const res = await fetch(`${cfg.base}/organizations/${id}`, { headers: { authorization: `Bearer ${cfg.apiKey}` }, signal: AbortSignal.timeout(FETCH_MS) });
    const body: unknown = await res.json().catch(() => null);
    const name = res.ok && isRecord(body) ? str(body.name) : null;
    if (name !== null) names.set(id, name);
    return name;
  } catch {
    return null;
  }
}

export interface UserOrganization {
  id: string;
  name: string | null;
  role: string | null;
}

export async function userOrganizations(cfg: WorkosConfig, userId: string): Promise<UserOrganization[]> {
  const answer = await request(cfg, 'GET', `/user_management/organization_memberships?user_id=${encodeURIComponent(userId)}&statuses=active&${LIST}`);
  const out: UserOrganization[] = [];
  for (const m of rows(answer)) {
    const id = str(m.organization_id);
    if (id === null) continue;
    const role = isRecord(m.role) ? str(m.role.slug) : null;
    out.push({ id, name: await organizationName(cfg, id), role });
  }
  return out;
}

export interface OrganizationSummary {
  id: string;
  name: string | null;
  createdAt: string | null;
}

export async function listOrganizations(cfg: WorkosConfig): Promise<OrganizationSummary[]> {
  const answer = await request(cfg, 'GET', `/organizations?${LIST}`);
  return rows(answer).flatMap((o) => {
    const id = str(o.id);
    if (id === null) return [];
    const name = str(o.name);
    if (name !== null) names.set(id, name);
    return [{ id, name, createdAt: str(o.created_at) }];
  });
}

export async function createOrganization(cfg: WorkosConfig, name: string): Promise<string> {
  const id = str((await api(cfg, '/organizations', { name })).id);
  if (id === null) throw new WorkosError('WorkOS created the organization without an id', null, 502);
  rememberOrganizationName(id, name);
  return id;
}

export async function updateUserName(cfg: WorkosConfig, userId: string, first: string, last: string | null): Promise<void> {
  await request(cfg, 'PUT', `/user_management/users/${encodeURIComponent(userId)}`, { first_name: first, last_name: last ?? '' });
}

export async function renameOrganization(cfg: WorkosConfig, id: string, name: string): Promise<string> {
  const answer = await request(cfg, 'PUT', `/organizations/${id}`, { name });
  const saved = str(answer.name) ?? name;
  rememberOrganizationName(id, saved);
  return saved;
}

export async function addMembership(cfg: WorkosConfig, userId: string, organization: string, role: 'admin' | 'member'): Promise<void> {
  await api(cfg, '/user_management/organization_memberships', { user_id: userId, organization_id: organization, role_slug: role });
}

export async function revokeSession(cfg: WorkosConfig, sessionId: string): Promise<void> {
  const res = await fetch(`${cfg.base}/user_management/sessions/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok && res.status !== 404) throw new WorkosError(`WorkOS refused the sign-out (${String(res.status)})`, null, 502);
}
