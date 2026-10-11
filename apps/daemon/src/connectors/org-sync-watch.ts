import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { METRO_API, type MetroApi } from './metro-api.js';
import { OrgConnectorSync, type OrgSyncDeps } from './org-sync.js';
import { OrgConnectorRuntime } from './org-runtime.js';
import { isOrgRelayId } from './relay-id.js';
import type { RelaySession } from './relay-session.js';

const POLL_MS = 60_000;
let active: OrgConnectorSync | null = null;
let runtime: OrgConnectorRuntime | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const liveEnabled = (): boolean => process.env.METRO_CONNECTORS_LIVE_ENABLED === 'true';

export function orgConnectorRelaySession(id: string): RelaySession | null {
  if (!isOrgRelayId(id)) return null;
  if (!liveEnabled() || runtime === null) throw new ApiError('Organization connectors are not available on this agent.', 503);
  return runtime.open(id);
}

export function invalidateOrgConnectorSync(): void {
  active?.invalidate();
}

export function stopOrgConnectorSync(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  runtime?.stop();
  runtime = null;
  active?.invalidate();
  active = null;
}

export function watchOrgConnectorSync(deps: Pick<OrgSyncDeps, 'owner' | 'key'> & { api?: MetroApi }): void {
  stopOrgConnectorSync();
  const enabled = (): boolean => process.env.METRO_CONNECTORS_SYNC_ENABLED === 'true';
  if (!enabled()) return;
  const sync = new OrgConnectorSync({ ...deps, enabled, api: deps.api ?? METRO_API });
  active = sync;
  if (liveEnabled()) runtime = new OrgConnectorRuntime(sync, { enabled: liveEnabled });
  const tick = (): void => {
    sync.sync().catch((err: unknown) => {
      log.warn({ status: err instanceof ApiError ? err.status : 503 }, 'organization connectors: memory sync failed; cached credentials were cleared');
    });
  };
  tick();
  timer = setInterval(tick, POLL_MS);
  timer.unref();
}
