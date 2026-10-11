import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { METRO_API, type MetroApi } from './metro-api.js';
import { OrgConnectorSync, type OrgSyncDeps } from './org-sync.js';

const POLL_MS = 60_000;
let active: OrgConnectorSync | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function invalidateOrgConnectorSync(): void {
  active?.invalidate();
}

export function stopOrgConnectorSync(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  active?.invalidate();
  active = null;
}

export function watchOrgConnectorSync(deps: Pick<OrgSyncDeps, 'owner' | 'key'> & { api?: MetroApi }): void {
  stopOrgConnectorSync();
  const enabled = (): boolean => process.env.METRO_CONNECTORS_SYNC_ENABLED === 'true';
  if (!enabled()) return;
  const sync = new OrgConnectorSync({ ...deps, enabled, api: deps.api ?? METRO_API });
  active = sync;
  const tick = (): void => {
    sync.sync().catch((err: unknown) => {
      sync.invalidate();
      log.warn({ status: err instanceof ApiError ? err.status : 503 }, 'organization connectors: memory sync failed; cached credentials were cleared');
    });
  };
  tick();
  timer = setInterval(tick, POLL_MS);
  timer.unref();
}
