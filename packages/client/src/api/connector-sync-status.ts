import type { ConnectorSyncStatus } from '@metro-labs/core/connector-sync';
import { isRecord } from '../read.js';

export type { ConnectorSyncStatus } from '@metro-labs/core/connector-sync';

export const SYNC_UNAVAILABLE = 'Could not read connector sync status. Refresh status to try again.';
const SOURCES: readonly ConnectorSyncStatus['source'][] = ['saved', 'environment', 'default', 'invalid', 'scope_changed'];
const STATES: readonly ConnectorSyncStatus['state'][] = ['off', 'not_enrolled', 'waiting', 'received', 'expired', 'unavailable'];
const timestamp = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const invalid = (): Error => new Error(SYNC_UNAVAILABLE);

function countsOf(value: unknown): ConnectorSyncStatus['counts'] {
  if (value === null) return null;
  if (!isRecord(value) || !count(value.total) || !count(value.ready) || !count(value.unavailable) || value.total !== value.ready + value.unavailable) throw invalid();
  return { total: value.total, ready: value.ready, unavailable: value.unavailable };
}

function settingsOf(value: Record<string, unknown>) {
  if (typeof value.enabled !== 'boolean' || typeof value.enrolled !== 'boolean' || typeof value.liveEnabled !== 'boolean') throw invalid();
  const source = SOURCES.find((item) => item === value.source);
  const state = STATES.find((item) => item === value.state);
  if (source === undefined || state === undefined) throw invalid();
  return { enabled: value.enabled, enrolled: value.enrolled, liveEnabled: value.liveEnabled, source, state };
}

function receiptOf(value: Record<string, unknown>) {
  if (typeof value.scope !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.scope) || !timestamp(value.lastReceivedAt) || !timestamp(value.leaseExpiresAt)) throw invalid();
  return { scope: value.scope, lastReceivedAt: value.lastReceivedAt, leaseExpiresAt: value.leaseExpiresAt, counts: countsOf(value.counts) };
}

function checkReceipt(status: ConnectorSyncStatus): void {
  if (status.state !== 'received') {
    if (status.counts !== null) throw invalid();
    return;
  }
  if (!status.enabled || !status.enrolled || status.counts === null || status.lastReceivedAt === null || status.leaseExpiresAt === null || status.leaseExpiresAt <= status.lastReceivedAt) throw invalid();
}

function checkState(status: ConnectorSyncStatus): void {
  if (['invalid', 'scope_changed'].includes(status.source) && status.enabled) throw invalid();
  if (status.enabled === (status.state === 'off')) throw invalid();
  if (status.state === 'not_enrolled' && status.enrolled) throw invalid();
  if (!status.enrolled && !['off', 'not_enrolled'].includes(status.state)) throw invalid();
}

export function currentSyncStatus(status: ConnectorSyncStatus, now = Date.now()): ConnectorSyncStatus {
  return status.state === 'received' && (status.leaseExpiresAt === null || status.leaseExpiresAt <= now)
    ? { ...status, state: 'expired', counts: null }
    : status;
}

export function connectorSyncStatusOf(value: unknown, organization: string, agent: string): ConnectorSyncStatus {
  if (!isRecord(value)) throw invalid();
  const settings = settingsOf(value);
  if (value.owner !== organization || (settings.enrolled ? value.agentId !== agent : value.agentId !== null)) throw invalid();
  const status = { ...settings, ...receiptOf(value), owner: organization, agentId: settings.enrolled ? agent : null };
  checkState(status);
  checkReceipt(status);
  return currentSyncStatus(status);
}

export function syncReceiptLabel(status: ConnectorSyncStatus): string {
  const current = currentSyncStatus(status);
  if (current.state === 'received' && current.counts !== null) {
    if (current.counts.total === 0) return 'Received an empty snapshot. No organization connectors were delivered.';
    return `Received ${String(current.counts.total)} connectors: ${String(current.counts.ready)} ready, ${String(current.counts.unavailable)} unavailable.`;
  }
  const labels = {
    off: 'Sync is off.',
    not_enrolled: 'Enroll this agent with the organization before enabling sync.',
    waiting: 'Waiting for the first delivery. Refresh status to check.',
    expired: 'The last delivery expired, so no counts are shown.',
    unavailable: 'Connector delivery is unavailable. Refresh status to check again.',
    received: SYNC_UNAVAILABLE,
  };
  return labels[current.state];
}
