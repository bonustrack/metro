import { ApiError } from '@metro-labs/http/api-error';
import type { ConnectorSyncStatus } from '@metro-labs/core/connector-sync';
import { OrgConnectorControl } from './org-sync-control.js';
import type { RelaySession } from './relay-session.js';

let active: OrgConnectorControl | null = null;

function control(): OrgConnectorControl {
  if (active === null) throw new ApiError('Organization connector sync is unavailable. Restart Metro before trying again.', 503);
  return active;
}

export function orgConnectorRelaySession(id: string): Promise<RelaySession> {
  return control().open(id);
}

export function orgConnectorSyncStatus(): ConnectorSyncStatus {
  return control().status();
}

export function setOrgConnectorSync(enabled: boolean, scope: string): ConnectorSyncStatus {
  return control().set(enabled, scope);
}

export function invalidateOrgConnectorSync(): void {
  active?.invalidate();
}

export function stopOrgConnectorSync(keepPublished = false): void {
  active?.stop(keepPublished);
  active = null;
}

export function watchOrgConnectorSync(deps: ConstructorParameters<typeof OrgConnectorControl>[0]): void {
  stopOrgConnectorSync();
  active = new OrgConnectorControl(deps);
  active.start();
}
