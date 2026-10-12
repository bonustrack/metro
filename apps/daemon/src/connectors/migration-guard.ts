import { ApiError } from '@metro-labs/http/api-error';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { agentsDir } from '../agents/files.js';
import type { AgentKey } from './agent-key.js';
import { migrationRecord, migrationRecords } from './migration-state.js';
import { assertMigrationOutcomeKnown, beginMigrationOperation, migrationOperationsIdle, migrationRequestEffectful, type MigrationOperation } from './migration-operations.js';

const locked = (phase: string): boolean => phase !== 'rolled_back';
const retired = (record: NonNullable<ReturnType<typeof migrationRecord>>): boolean => record.move === true || record.phase === 'cutover' || record.phase === 'active' || record.phase === 'rollback';
const refused = (): ApiError => new ApiError('This local connector is locked while it moves to the organization.', 409);

export function migrationSource(id: string, dir = agentsDir()): ReturnType<typeof migrationRecords>[number] | null {
  const record = migrationRecord(id, dir);
  return record !== null && locked(record.phase) ? record : null;
}

export function localMigrationEnabled(id: string, dir = agentsDir()): boolean {
  const record = migrationSource(id, dir);
  return record === null || !retired(record);
}

export function assertLocalMigrationUse(id: string, dir = agentsDir()): void {
  const record = migrationSource(id, dir);
  if (record === null) return;
  if (retired(record)) throw refused();
  assertMigrationOutcomeKnown(id, dir);
}

export function assertLocalMigrationEdit(id: string, name: string | undefined, dir = agentsDir()): void {
  if (migrationRecords(dir).some((record) => locked(record.phase) && (record.sourceId === id || record.name === name))) throw refused();
}

export function migrationExportableRows<T extends { id: string; name: string }>(rows: readonly T[], dir = agentsDir()): T[] {
  const records = migrationRecords(dir).filter((record) => locked(record.phase));
  return rows.filter((row) => !records.some((record) => record.sourceId === row.id || record.name === row.name));
}

export function localMigrationIdle(id: string, dir = agentsDir(), allowUncertain = false): boolean {
  return migrationOperationsIdle(id, dir, !allowUncertain && migrationSource(id, dir) !== null);
}

export interface LocalMigrationOperation extends MigrationOperation {
  check: () => void;
  fetch: FetchLike;
  close: () => void;
}

export function beginLocalMigrationOperation(id: string, dir = agentsDir(), edit = false, name?: string): LocalMigrationOperation {
  let closed = false;
  const check = (): void => {
    if (closed) throw refused();
    if (edit) assertLocalMigrationEdit(id, name, dir);
    else assertLocalMigrationUse(id, dir);
  };
  check();
  const tracked = beginMigrationOperation(id, dir, migrationSource(id, dir) !== null);
  const dispatch: MigrationOperation['dispatch'] = (send, options) => {
    check();
    return tracked.dispatch(send, { ...options, protectedSource: migrationSource(id, dir) !== null });
  };
  return {
    check,
    dispatch,
    persistedRefresh: tracked.persistedRefresh,
    fetch: (input, init) => dispatch(() => fetch(input, init), { effectful: migrationRequestEffectful(init?.method, init?.body) }),
    close: () => { closed = true; tracked.close(); },
  };
}

export async function withLocalMigrationOperation<T>(id: string, dir: string, run: (operation: LocalMigrationOperation) => Promise<T>, edit = false, name?: string): Promise<T> {
  const operation = beginLocalMigrationOperation(id, dir, edit, name);
  try { return await run(operation); }
  finally { operation.close(); }
}

export interface MigrationRuntimeMapping {
  aliases: { sourceId: string; destinationId: string; name: string }[];
  reserved: string[];
}

export function migrationRuntimeMapping(owner: string | null, key: AgentKey | null, dir = agentsDir()): MigrationRuntimeMapping {
  const records = migrationRecords(dir).filter((record) => locked(record.phase));
  const aliases = records.flatMap((record) => {
    if (record.phase !== 'active' || record.destinationId === null || owner === null || key === null) return [];
    if (record.owner !== owner || record.keyId !== key.keyId || record.owner !== key.enrollment?.organization || record.agentId !== key.enrollment.server) return [];
    return [{ sourceId: record.sourceId, destinationId: record.destinationId, name: record.name }];
  });
  const reserved = records.flatMap((record) => record.destinationId === null ? [] : [record.destinationId]);
  if (new Set(aliases.map((alias) => alias.sourceId)).size !== aliases.length || new Set(reserved).size !== reserved.length) throw refused();
  return { aliases, reserved };
}
