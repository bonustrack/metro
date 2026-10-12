import { saveMigration, type MigrationPhase, type MigrationRecord } from '../src/connectors/migration-state.ts';

export const SOURCE = 'local000001';
export const DESTINATION = 'conn0000001';
export const SOURCE_NAME = 'Local MCP';

export function migration(dir: string, phase: MigrationPhase, overrides: Partial<MigrationRecord> = {}): MigrationRecord {
  const record: MigrationRecord = {
    id: 'migrate0001', sourceId: SOURCE, name: SOURCE_NAME, owner: 'org_01AGENTOWNER00000', agentId: 'agent000001', keyId: 'k'.repeat(43),
    destinationId: DESTINATION, phase, auth: 'header', sourceStamp: 's'.repeat(43), policy: { write: 'ask' }, reason: null, ...overrides,
  };
  saveMigration(record, dir);
  return record;
}
