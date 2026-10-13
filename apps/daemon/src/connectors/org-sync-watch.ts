import { ApiError } from '@metro-labs/http/api-error';
import type { ConnectorSyncStatus } from '@metro-labs/core/connector-sync';
import { OrgConnectorControl } from './org-sync-control.js';
import { isOrgRelayId } from './relay-id.js';
import type { RelaySession } from './relay-session.js';
import type { DeliverySnapshot } from '@metro-labs/http/connector-delivery';
import { migrationSource } from './migration-guard.js';

let active: OrgConnectorControl | null = null;

function control(): OrgConnectorControl {
  if (active === null) throw new ApiError('Organization connector sync is unavailable. Restart Metro before trying again.', 503);
  return active;
}

export function orgConnectorRelaySession(id: string): Promise<RelaySession> | null {
  return isOrgRelayId(id) || migrationSource(id)?.phase === 'active' ? control().open(id) : null;
}

export function freshOrgConnectors(): Promise<DeliverySnapshot> {
  return control().fresh();
}

export function refreshOrgConnectorRuntime(): void {
  control().refreshRuntime();
}

export function orgConnectorMigrationIdle(id: string): boolean {
  return control().migrationIdle(id);
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
