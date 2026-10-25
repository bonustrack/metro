import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { ApiError } from '@metro-labs/http/api-error';
import type { Session, SigningKeys } from '@metro-labs/http/workos-token';
import type { OrgModelStore } from '@metro-labs/connectors/db/models';
import type { ModelRefreshDeps } from '@metro-labs/connectors/model-refresh';
import { OwnerTickets } from '../agents/tickets.js';
import type { ListCache } from './list-cache.js';
import type { ModelUsageStore } from '@metro-labs/connectors/db/model-call-stats';

const DEVICE_TTL_MS = 15 * 60_000;

export interface CodexPending {
  owner: string;
  userId: string;
  connection: string | null;
  verifier: string;
  nonce: string;
  clientId: string | null;
  subject: string | null;
}

export interface DevicePending {
  owner: string;
  userId: string;
  connection: string | null;
  deviceAuthId: string;
  userCode: string;
  interval: number;
  polledAt: number | null;
}

export interface OpenRouterPending {
  owner: string;
  userId: string;
  connection: string | null;
  revision: number | null;
  verifier: string;
  returnTo: string;
}

export interface ModelsDeps {
  key: () => Buffer | null;
  keys: SigningKeys;
  store: OrgModelStore;
  fetch: FetchLike;
  now: () => number;
  openrouterCallback: string;
  codexLogins: OwnerTickets<CodexPending>;
  devices: OwnerTickets<DevicePending>;
  openrouterLogins: OwnerTickets<OpenRouterPending>;
  lists: ListCache;
  usage: ModelUsageStore;
}

export interface Caller {
  session: Session;
  owner: string;
}

export const MODELS_MAX = 100;

const slot = (pending: { userId: string; connection: string | null }): string => `${pending.userId}\n${pending.connection ?? ''}`;

export const codexLogins = (): OwnerTickets<CodexPending> => new OwnerTickets<CodexPending>(slot, { what: 'Codex sign-ins' });

export const deviceLogins = (): OwnerTickets<DevicePending> => new OwnerTickets<DevicePending>(slot, { what: 'Codex sign-ins', ttlMs: DEVICE_TTL_MS });

export const openrouterLogins = (): OwnerTickets<OpenRouterPending> => new OwnerTickets<OpenRouterPending>(slot, { what: 'OpenRouter sign-ins' });

export function modelKey(deps: { key: () => Buffer | null }): Buffer {
  const key = deps.key();
  if (key === null) throw new ApiError('Metro cannot keep model secrets yet: METRO_CONNECTORS_KEY is not set.', 503);
  return key;
}

export const isoNow = (deps: { now: () => number }): string => new Date(deps.now()).toISOString();

export const userActor = (caller: Caller): string => `user:${caller.session.userId}`;

export const refreshDeps = (deps: Pick<ModelsDeps, 'store' | 'fetch' | 'now'>, key: Buffer): ModelRefreshDeps => ({ key, store: deps.store, fetch: deps.fetch, now: deps.now });
