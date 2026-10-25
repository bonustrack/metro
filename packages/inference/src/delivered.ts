import { readEffort, type RouteEffort } from '@metro-labs/core/effort';
import { isRecord } from '@metro-labs/core/is-record';
import { emptySetup, isProvider, type ModelSetup, type Account, type Chain, type CodexAccess, type Connection, type Fallback, type Provider, type RouteSource } from './model-config.js';

export interface DeliveredRoute {
  primary: Fallback | null;
  fallbacks: Fallback[];
  helpers: Chain | null;
  effort: RouteEffort;
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

function fallbacksOf(raw: Record<string, unknown>): Fallback[] {
  const fallbacks = Array.isArray(raw.fallbacks) ? raw.fallbacks.flatMap((f: unknown) => refOf(f) ?? []) : [];
  return fallbacks.filter((f) => f.model !== '').slice(0, MAX_FALLBACKS);
}

function helpersOf(raw: unknown): Chain | null {
  if (!isRecord(raw)) return null;
  const primary = refOf(raw.primary);
  return primary === null ? null : { primary, fallbacks: fallbacksOf(raw) };
}

function routeOf(raw: unknown): DeliveredRoute | null {
  if (!isRecord(raw)) return null;
  return { primary: refOf(raw.primary), fallbacks: fallbacksOf(raw), helpers: helpersOf(raw.helpers), effort: readEffort(raw.effort) };
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

interface Credential {
  apiKey: string;
  claudeToken: string;
  codex: CodexAccess | null;
}

function credentialOf(provider: Provider, raw: unknown): Credential {
  if (!isRecord(raw)) return { apiKey: '', claudeToken: '', codex: null };
  if (provider === 'codex') return { apiKey: '', claudeToken: '', codex: codexOf(raw) };
  return { apiKey: text(raw.apiKey), claudeToken: provider === 'anthropic' ? text(raw.claudeToken) : '', codex: null };
}

export function deliveredConnection(raw: unknown): Connection | null {
  if (!isRecord(raw) || !isProvider(raw.provider)) return null;
  const id = text(raw.id);
  if (id === '') return null;
  const { apiKey, claudeToken, codex } = credentialOf(raw.provider, raw.credential);
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
    claudeToken,
    account: accountOf(raw.account),
    signedOut: codex === null && apiKey === '' && claudeToken === '',
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

export function setupOf(delivered: Delivered | null): ModelSetup {
  const route = delivered?.route ?? null;
  if (delivered === null || route === null) return { ...emptySetup(), source: delivered?.source ?? null };
  return { primary: route.primary, fallbacks: route.fallbacks, connections: delivered.connections, source: delivered.source, helpers: route.helpers, effort: route.effort };
}
