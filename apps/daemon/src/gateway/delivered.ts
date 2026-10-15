import { isRecord } from '@metro-labs/core/is-record';
import { isProvider, LOCAL_PREFIX, type Account, type CodexAccess, type Connection, type Fallback, type Provider, type RouteSource } from './model-config.js';

export interface DeliveredRoute {
  primary: Fallback | null;
  fallbacks: Fallback[];
}

export interface Delivered {
  route: DeliveredRoute | null;
  source: RouteSource | null;
  connections: Connection[];
}

const MAX_FALLBACKS = 8;
const MAX_CONNECTIONS = 20;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const maybe = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function refOf(raw: unknown): Fallback | null {
  if (!isRecord(raw)) return null;
  const ref = { connection: text(raw.connection), model: text(raw.model) };
  return ref.connection === '' ? null : ref;
}

function routeOf(raw: unknown): DeliveredRoute | null {
  if (!isRecord(raw)) return null;
  const fallbacks = Array.isArray(raw.fallbacks) ? raw.fallbacks.flatMap((f: unknown) => refOf(f) ?? []) : [];
  return { primary: refOf(raw.primary), fallbacks: fallbacks.filter((f) => f.model !== '' || f.connection.startsWith(LOCAL_PREFIX)).slice(0, MAX_FALLBACKS) };
}

function accountOf(raw: unknown): Account {
  const account = isRecord(raw) ? raw : {};
  const method = account.method === 'chatgpt' || account.method === 'code' ? account.method : null;
  return { email: maybe(account.email), plan: maybe(account.plan), method };
}

const numberOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function codexOf(raw: Record<string, unknown>): CodexAccess | null {
  const accessToken = text(raw.accessToken);
  if (accessToken === '' || (raw.method !== 'chatgpt' && raw.method !== 'code')) return null;
  return { method: raw.method, accessToken, expiresAt: numberOf(raw.expiresAt), accountId: maybe(raw.accountId) };
}

function credentialOf(provider: Provider, raw: unknown): { apiKey: string; codex: CodexAccess | null } {
  if (!isRecord(raw)) return { apiKey: '', codex: null };
  return provider === 'codex' ? { apiKey: '', codex: codexOf(raw) } : { apiKey: text(raw.apiKey), codex: null };
}

export function deliveredConnection(raw: unknown): Connection | null {
  if (!isRecord(raw) || !isProvider(raw.provider)) return null;
  const id = text(raw.id);
  if (id === '' || id.startsWith(LOCAL_PREFIX)) return null;
  const { apiKey, codex } = credentialOf(raw.provider, raw.credential);
  return {
    id,
    provider: raw.provider,
    label: text(raw.label) === '' ? raw.provider : text(raw.label),
    model: text(raw.model),
    apiKey,
    region: text(raw.region),
    zdr: raw.zdr === true,
    revision: numberOf(raw.revision),
    codex,
    claude: null,
    account: accountOf(raw.account),
    signedOut: codex === null && apiKey === '',
  };
}

export function deliveredOf(raw: Record<string, unknown>): Delivered | null {
  if (!Array.isArray(raw.connections) || (raw.route !== null && !isRecord(raw.route))) return null;
  const source = raw.source === 'agent' || raw.source === 'organization' ? raw.source : null;
  const connections = raw.connections.flatMap((c: unknown) => deliveredConnection(c) ?? []).slice(0, MAX_CONNECTIONS);
  return { route: routeOf(raw.route), source, connections };
}

export function refreshedConnection(raw: Record<string, unknown>): Connection | null {
  return deliveredConnection(isRecord(raw.connection) ? raw.connection : raw);
}
