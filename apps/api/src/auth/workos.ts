import { isRecord } from '@metro-labs/core/is-record';
import { filled, workosBase } from '@metro-labs/http/workos-token';

export const PROVIDERS = { google: 'GoogleOAuth', microsoft: 'MicrosoftOAuth' } as const;
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
  user: { id: string; email: string | null; name: string | null; picture: string | null };
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

export const isProvider = (value: unknown): value is Provider => value === 'google' || value === 'microsoft';
export const ALL_PROVIDERS: Provider[] = ['google', 'microsoft'];
const PROBE_MS = 10 * 60_000;

export async function providerEnabled(cfg: WorkosConfig, provider: Provider, redirectUri: string): Promise<boolean> {
  try {
    const res = await fetch(authorizationUrl(cfg, provider, redirectUri, 'probe'), { redirect: 'manual', signal: AbortSignal.timeout(FETCH_MS) });
    return res.status >= 300 && res.status < 400;
  } catch {
    return false;
  }
}

let probed: { at: number; providers: Provider[] } | null = null;

export async function enabledProviders(cfg: WorkosConfig, redirectUri: string, now = Date.now()): Promise<Provider[]> {
  if (probed !== null && now - probed.at < PROBE_MS) return probed.providers;
  const answers = await Promise.all(ALL_PROVIDERS.map((p) => providerEnabled(cfg, p, redirectUri)));
  probed = { at: now, providers: ALL_PROVIDERS.filter((_, i) => answers[i] === true) };
  return probed.providers;
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
    user: { id, email: str(body.user.email), name: name === '' ? null : name, picture: str(body.user.profile_picture_url) },
  };
}

async function authenticate(cfg: WorkosConfig, grant: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${cfg.base}/user_management/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.apiKey, ...grant }),
    signal: AbortSignal.timeout(FETCH_MS),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = isRecord(body) ? str(body.code) ?? str(body.error) : null;
    const message = isRecord(body) ? str(body.message) ?? str(body.error_description) : null;
    throw new WorkosError(message ?? `WorkOS answered ${String(res.status)}`, code, res.status === 400 || res.status === 401 ? 401 : 502);
  }
  return tokensOf(body);
}

export const exchangeCode = (cfg: WorkosConfig, code: string): Promise<Tokens> => authenticate(cfg, { grant_type: 'authorization_code', code });

export const refreshTokens = (cfg: WorkosConfig, refreshToken: string, organization?: string): Promise<Tokens> =>
  authenticate(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken, ...(organization === undefined ? {} : { organization_id: organization }) });

async function api(cfg: WorkosConfig, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${cfg.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_MS),
  });
  const answer: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = isRecord(answer) ? str(answer.message) : null;
    throw new WorkosError(message ?? `WorkOS answered ${String(res.status)} on ${path}`, isRecord(answer) ? str(answer.code) : null, 502);
  }
  return isRecord(answer) ? answer : {};
}

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

export async function createOrganization(cfg: WorkosConfig, name: string): Promise<string> {
  const id = str((await api(cfg, '/organizations', { name })).id);
  if (id === null) throw new WorkosError('WorkOS created the organization without an id', null, 502);
  rememberOrganizationName(id, name);
  return id;
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
