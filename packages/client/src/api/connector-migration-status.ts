import { isRecord } from '../read.js';
import type { MigrationIdentity } from './connector-migration-identity.js';

export type MigrationAction = 'move' | 'prepare' | 'reconcile' | 'cutover' | 'rollback' | 'resolve';
export type MigrationPhase = 'recovering' | 'freezing' | 'preparing' | 'prepared' | 'cutover' | 'active' | 'rollback' | 'rolled_back';
export type MigrationReason = 'sign_in' | 'not_verified' | 'source_changed' | 'destination_changed' | 'assignment_changed' | 'waiting_for_local' | 'sync_unavailable' | 'identity_changed' | 'rolled_back' | 'unavailable' | 'requests_uncertain' | 'unknown' | 'refresh_uncertain' | 'local_refresh_uncertain' | 'finish_forward' | 'unsupported_grant';

export interface MigrationView {
  id: string;
  sourceId: string;
  name: string;
  destinationId: string | null;
  phase: MigrationPhase;
  auth: 'none' | 'header' | 'oauth';
  reason: MigrationReason | null;
  uncertainty: string | null;
  move?: boolean;
  grantImported?: boolean;
}

export interface MigrationStatus {
  scope: string;
  owner: string | null;
  agentId: string | null;
  enabled: boolean;
  enrolled: boolean;
  migrations: MigrationView[];
}

const REASONS: readonly MigrationReason[] = ['sign_in', 'not_verified', 'source_changed', 'destination_changed', 'assignment_changed', 'waiting_for_local', 'sync_unavailable', 'identity_changed', 'rolled_back', 'unavailable', 'requests_uncertain', 'refresh_uncertain', 'local_refresh_uncertain', 'finish_forward', 'unsupported_grant'];
const invalid = (): Error => new Error('The agent returned an invalid migration status. Refresh and Reconcile before continuing.');
const nullable = (value: unknown): value is string | null => value === null || typeof value === 'string';

const reasonOf = (value: string | null): MigrationReason | null => value === null ? null : REASONS.find((item) => item === value) ?? 'unknown';

function uncertaintyOf(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw invalid();
  return value;
}

function migrationOf(value: unknown): MigrationView {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.sourceId !== 'string' || typeof value.name !== 'string' || !nullable(value.destinationId) || !nullable(value.reason)) throw invalid();
  const phase = (['recovering', 'freezing', 'preparing', 'prepared', 'cutover', 'active', 'rollback', 'rolled_back'] as const).find((item) => item === value.phase);
  const auth = (['none', 'header', 'oauth'] as const).find((item) => item === value.auth);
  if (phase === undefined || auth === undefined) throw invalid();
  const reason = reasonOf(value.reason);
  return { id: value.id, sourceId: value.sourceId, name: value.name, destinationId: value.destinationId, phase, auth, reason, uncertainty: uncertaintyOf(value.uncertainty), move: value.move === true, grantImported: value.grantImported === true };
}

function envelopeOf(value: unknown): MigrationStatus {
  if (!isRecord(value) || typeof value.scope !== 'string' || !/^[a-f0-9]{64}$/.test(value.scope) || !nullable(value.owner) || !nullable(value.agentId)) throw invalid();
  if (typeof value.enabled !== 'boolean' || typeof value.enrolled !== 'boolean' || !Array.isArray(value.migrations)) throw invalid();
  const migrations = value.migrations.map(migrationOf);
  if (new Set(migrations.map((row) => row.sourceId)).size !== migrations.length) throw invalid();
  return { scope: value.scope, owner: value.owner, agentId: value.agentId, enabled: value.enabled, enrolled: value.enrolled, migrations };
}

export function migrationStatusOf(value: unknown, identity: MigrationIdentity, expectedScope: string | null): MigrationStatus {
  const status = envelopeOf(value);
  identity.check();
  if (status.owner !== identity.owner || (status.enrolled && status.agentId !== identity.agentId) || (expectedScope !== null && status.scope !== expectedScope)) {
    identity.invalidate();
    identity.check();
  }
  return status;
}
