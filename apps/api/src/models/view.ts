import { errMsg, log } from '@metro-labs/core/log';
import type { ModelConnectionRow } from '@metro-labs/connectors/db/models';
import type { ModelRoute } from '@metro-labs/connectors/model-route';
import { modelDetailOf, openModelSecret, type CodexMethod, type ModelDetail, type ModelSecret } from '@metro-labs/connectors/model-secret';

export interface AccountView {
  email: string | null;
  plan: string | null;
  method: CodexMethod | null;
}

export interface ConnectionView {
  id: string;
  provider: string;
  label: string;
  model: string;
  region: string;
  zdr: boolean;
  account: AccountView;
  signedOut: boolean;
  createdAt: string;
}

export interface ModelsView {
  connections: ConnectionView[];
  default: ModelRoute | null;
  agents: Record<string, ModelRoute>;
}

export type Credential = { apiKey: string } | { accessToken: string; expiresAt: number; method: CodexMethod; accountId: string | null } | null;

export interface AgentConnection {
  id: string;
  provider: string;
  label: string;
  model: string;
  region: string;
  zdr: boolean;
  revision: number;
  account: AccountView;
  credential: Credential;
}

const accountOf = (detail: ModelDetail): AccountView => ({ email: detail.email ?? null, plan: detail.plan ?? null, method: detail.method ?? null });

export function connectionView(row: ModelConnectionRow): ConnectionView {
  const detail = modelDetailOf(row.detail);
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    model: row.model,
    region: row.region,
    zdr: row.zdr,
    account: accountOf(detail),
    signedOut: detail.signedOut === true || row.secret === null,
    createdAt: row.createdAt,
  };
}

function credentialOf(secret: ModelSecret | null): Credential {
  if (secret === null) return null;
  if (secret.kind === 'key') return { apiKey: secret.apiKey };
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
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    model: row.model,
    region: row.region,
    zdr: row.zdr,
    revision: row.revision,
    account: accountOf(detail),
    credential: detail.signedOut === true ? null : credentialOf(readable(key, row)),
  };
}
