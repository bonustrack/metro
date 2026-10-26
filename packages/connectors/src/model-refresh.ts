import { errMsg, log } from '@metro-labs/core/log';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { isDeadGrant, refreshCodex, type Refreshed } from './codex-tokens.js';
import type { ModelConnectionRow, ModelEdit, OrgModelStore } from './db/models.js';
import { modelDetailOf, modelDetailText, openModelSecret, sealModelSecret, type CodexSecret, type ModelDetail, type ModelSecret } from './model-secret.js';

const REFRESH_BEFORE_MS = 5 * 60_000;
const FORCED_GAP_MS = 60_000;

export interface ModelRefreshDeps {
  key: Buffer;
  store: Pick<OrgModelStore, 'edit'>;
  fetch: FetchLike;
  now: () => number;
  issuer?: string;
}

const flights = new Map<string, Promise<ModelConnectionRow>>();

const unchanged = (): ModelEdit => ({ change: {} });

function opened(key: Buffer, row: ModelConnectionRow): ModelSecret | null {
  try {
    return openModelSecret(key, row);
  } catch {
    return null;
  }
}

function liveCodex(key: Buffer, row: ModelConnectionRow): CodexSecret | null {
  if (row.provider !== 'codex' || modelDetailOf(row.detail).signedOut === true) return null;
  const secret = opened(key, row);
  return secret?.kind === 'codex' ? secret : null;
}

export function codexStale(key: Buffer, row: ModelConnectionRow, now: number): boolean {
  const secret = liveCodex(key, row);
  return secret !== null && secret.expiresAt - now <= REFRESH_BEFORE_MS;
}

const issuedWithin = (detail: ModelDetail, now: number): boolean => [detail.refreshedAt, detail.signedInAt].some((at) => at !== undefined && now - Date.parse(at) < FORCED_GAP_MS);

function refreshedDetail(detail: ModelDetail, refreshed: Refreshed, now: number): ModelDetail {
  return {
    ...detail,
    refreshedAt: new Date(now).toISOString(),
    ...(refreshed.email === null ? {} : { email: refreshed.email }),
    ...(refreshed.plan === null ? {} : { plan: refreshed.plan }),
    ...(refreshed.secret.accountId === undefined ? {} : { accountId: refreshed.secret.accountId }),
  };
}

async function refreshEdit(deps: ModelRefreshDeps, row: ModelConnectionRow, forced: number | undefined): Promise<ModelEdit> {
  const detail = modelDetailOf(row.detail);
  if (forced !== undefined && (row.revision !== forced || issuedWithin(detail, deps.now()))) return unchanged();
  const secret = liveCodex(deps.key, row);
  if (secret === null || (forced === undefined && secret.expiresAt - deps.now() > REFRESH_BEFORE_MS)) return unchanged();
  try {
    const now = deps.now();
    const refreshed = await refreshCodex(secret, deps.fetch, now, deps.issuer);
    return { change: { secret: sealModelSecret(deps.key, row, refreshed.secret), detail: modelDetailText(refreshedDetail(detail, refreshed, now)) }, credential: true };
  } catch (err) {
    if (isDeadGrant(err)) {
      log.warn({ owner: row.owner, connection: row.id }, 'models: OpenAI refused the Codex refresh token, so the connection is signed out');
      return { change: { detail: modelDetailText({ ...detail, signedOut: true }) }, credential: true };
    }
    log.warn({ owner: row.owner, connection: row.id, err: errMsg(err) }, 'models: a Codex refresh failed, so the current token stands');
    return unchanged();
  }
}

export function refreshModelConnection(deps: ModelRefreshDeps, owner: string, id: string, forced?: number): Promise<ModelConnectionRow> {
  const name = `${owner}\n${id}`;
  const running = flights.get(name);
  if (running !== undefined) return running;
  const flight = deps.store.edit(owner, id, new Date(deps.now()).toISOString(), (row) => refreshEdit(deps, row, forced)).finally(() => {
    flights.delete(name);
  });
  flights.set(name, flight);
  return flight;
}
