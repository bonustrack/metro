import { isRecord } from '@metro-labs/core/is-record';
import { claudeLoginOf } from './claude-store.js';
import { isProvider, LOCAL_PREFIX, loginConnection, sessionConnection, type Account, type CodexAccess, type Connection, type Fallback, type ModelSetup, type Provider } from './model-config.js';

const MAX_CONNECTIONS = 20;
const MAX_FALLBACKS = 8;
const NEW_CLIENT = 'dynamic_agent_client';
const NO_ACCOUNT: Account = { email: null, plan: null, method: null };

type Row = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const maybe = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const expiryOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function codexOf(raw: unknown): CodexAccess | null {
  if (!isRecord(raw) || text(raw.accessToken) === '' || text(raw.refreshToken) === '') return null;
  const accountId = maybe(text(raw.accountId));
  const clientId = text(raw.clientId);
  if (accountId === null && (clientId === '' || clientId === NEW_CLIENT)) return null;
  return { method: accountId === null ? 'chatgpt' : 'code', accessToken: text(raw.accessToken), expiresAt: expiryOf(raw.expiresAt), accountId };
}

function accountOf(raw: unknown, codex: CodexAccess | null): Account {
  if (codex === null || !isRecord(raw)) return NO_ACCOUNT;
  return { email: maybe(raw.email), plan: codex.method === 'code' ? maybe(raw.plan) : null, method: codex.method };
}

function ownConnection(row: Row, id: string, provider: Provider): Connection {
  const codex = provider === 'codex' ? codexOf(row.codex) : null;
  const apiKey = provider === 'codex' ? '' : text(row.apiKey);
  const label = text(row.label);
  return {
    id,
    provider,
    label: label === '' ? provider : label,
    model: text(row.model),
    apiKey,
    region: text(row.region),
    zdr: row.zdr === true,
    revision: 0,
    codex,
    claude: null,
    account: accountOf(row.codex, codex),
    signedOut: codex === null && apiKey === '',
  };
}

function connectionOf(row: Row): Connection | null {
  const id = text(row.id);
  if (id === '' || id.startsWith(LOCAL_PREFIX) || !isProvider(row.provider)) return null;
  if (row.provider !== 'anthropic' || text(row.apiKey) !== '') return ownConnection(row, id, row.provider);
  const login = claudeLoginOf(row.claude);
  return login === null ? sessionConnection() : loginConnection(login.id, login);
}

function fallbacksOf(raw: unknown, linked: Map<string, Connection>): Fallback[] {
  if (!Array.isArray(raw)) return [];
  const known = raw.flatMap((f: unknown) => {
    const conn = isRecord(f) ? linked.get(text(f.connection)) : undefined;
    const model = isRecord(f) ? text(f.model) : '';
    return conn === undefined || model === '' ? [] : [{ connection: conn.id, model }];
  });
  return known.filter((f, at) => known.findIndex((o) => o.connection === f.connection && o.model === f.model) === at).slice(0, MAX_FALLBACKS);
}

export function v2Setup(raw: Row & { connections: unknown[] }): ModelSetup {
  const rows = raw.connections.filter((c): c is Row => isRecord(c) && (isProvider(c.provider) || c.provider === 'gemini')).slice(0, MAX_CONNECTIONS);
  const linked = new Map(rows.flatMap((row) => {
    const conn = connectionOf(row);
    return conn === null ? [] : [[text(row.id), conn] as const];
  }));
  const routed = rows.find((row) => text(row.id) === text(raw.route)) ?? rows[0];
  const head = routed === undefined ? undefined : linked.get(text(routed.id));
  const primary = routed === undefined || head === undefined ? null : { connection: head.id, model: text(routed.model) };
  const connections = [...linked.values()].filter((c, at, all) => all.findIndex((o) => o.id === c.id) === at);
  return { primary, fallbacks: fallbacksOf(raw.fallbacks, linked), connections, source: null };
}
