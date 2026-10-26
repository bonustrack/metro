import { errMsg, log } from '@metro-labs/core/log';
import type { AgentModelSetup, RouteSource } from './db/model-delivery.js';
import type { ModelConnectionRow } from './db/models.js';
import { codexStale, refreshModelConnection, type ModelRefreshDeps } from './model-refresh.js';
import type { ModelRoute } from './model-route.js';
import { modelDetailOf, openModelSecret, type CodexMethod, type ModelDetail, type ModelSecret } from './model-secret.js';

export interface AccountView {
  email: string | null;
  plan: string | null;
  method: CodexMethod | null;
}

type Credential = { apiKey: string } | { claudeToken: string } | { accessToken: string; expiresAt: number; method: CodexMethod; accountId: string | null } | null;

export interface AgentConnection {
  id: string;
  provider: string;
  label: string;
  model: string;
  region: string;
  zdr: boolean;
  revision: number;
  account: AccountView;
  auth: CredentialKind | null;
  signedOut: boolean;
  credential: Credential;
}

type CredentialKind = 'key' | 'subscription' | 'codex';

export const accountOf = (detail: ModelDetail): AccountView => ({ email: detail.email ?? null, plan: detail.plan ?? null, method: detail.method ?? null });

function kindOf(secret: ModelSecret | null): CredentialKind | null {
  if (secret === null) return null;
  if (secret.kind === 'key') return 'key';
  return secret.kind === 'claude' ? 'subscription' : 'codex';
}

function credentialOf(secret: ModelSecret | null): Credential {
  if (secret === null) return null;
  if (secret.kind === 'key') return { apiKey: secret.apiKey };
  if (secret.kind === 'claude') return { claudeToken: secret.token };
  return { accessToken: secret.accessToken, expiresAt: secret.expiresAt, method: secret.method, accountId: secret.accountId ?? null };
}

function readable(key: Buffer, row: ModelConnectionRow): ModelSecret | null {
  try {
    return openModelSecret(key, row);
  } catch (err) {
    log.warn({ owner: row.owner, connection: row.id, err: errMsg(err) }, 'models: a model secret could not be opened, so it is not delivered');
    return null;
  }
}

export function agentConnection(key: Buffer, row: ModelConnectionRow): AgentConnection {
  const detail = modelDetailOf(row.detail);
  const secret = readable(key, row);
  const signedOut = detail.signedOut === true || secret === null;
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    model: row.model,
    region: row.region,
    zdr: row.zdr,
    revision: row.revision,
    account: accountOf(detail),
    auth: kindOf(secret),
    signedOut,
    credential: signedOut ? null : credentialOf(secret),
  };
}

export interface AgentModels {
  route: ModelRoute | null;
  source: RouteSource;
  connections: AgentConnection[];
  chatgptHostId: string;
}

export async function agentModelsOf(deps: ModelRefreshDeps, setup: AgentModelSetup, owner: string): Promise<AgentModels> {
  const stale = setup.connections.filter((row) => codexStale(deps.key, row, deps.now()));
  const fresh = await Promise.all(stale.map((row) => refreshModelConnection(deps, owner, row.id)));
  const rows = setup.connections.map((row) => fresh.find((held) => held.id === row.id) ?? row);
  return { route: setup.route, source: setup.source, connections: rows.map((row) => agentConnection(deps.key, row)), chatgptHostId: setup.hostId };
}
