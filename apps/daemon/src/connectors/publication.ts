import { registerConnectors, type GateRow } from './gates.js';
import { serverKeysOf, syncPluginServers } from './plugin-sync.js';
import { isOrgRelayId } from './relay-id.js';
import { migrationRecords } from './migration-state.js';

let local: GateRow[] = [];
let organization: GateRow[] = [];

function metadata(rows: readonly GateRow[]): GateRow[] {
  return rows.map((row) => structuredClone({
    id: row.id,
    name: row.name,
    config: {
      ...(row.config.policy === undefined ? {} : { policy: row.config.policy }),
      ...(row.config.toolGroups === undefined ? {} : { toolGroups: row.config.toolGroups }),
    },
  }));
}

export function publishConnectors(): void {
  let records: ReturnType<typeof migrationRecords>;
  try { records = migrationRecords().filter((record) => record.phase !== 'rolled_back'); }
  catch (error) {
    registerConnectors([], local.map((row) => row.id));
    syncPluginServers([]);
    throw error;
  }
  const retired = new Set(records.filter((record) => !['preparing', 'prepared'].includes(record.phase)).map((record) => record.sourceId));
  const aliases = new Map(organization.filter((row) => records.some((record) => record.phase === 'active' && record.sourceId === row.id && record.name === row.name)).map((row) => [row.id, row]));
  const rows = local.flatMap((row) => {
    const alias = aliases.get(row.id);
    return alias !== undefined ? [alias] : retired.has(row.id) ? [] : [row];
  });
  rows.push(...organization.filter((row) => isOrgRelayId(row.id) && !records.some((record) => row.id === `org-${record.destinationId ?? ''}`)));
  const keys = serverKeysOf([...local, ...rows.filter((row) => isOrgRelayId(row.id))]);
  registerConnectors(rows, [...retired, ...aliases.keys()], keys);
  syncPluginServers(rows, { keys });
}

export function publishLocalConnectors(rows: readonly GateRow[]): void {
  local = metadata(rows.filter((row) => !isOrgRelayId(row.id)));
  publishConnectors();
}

export function publishOrgConnectors(rows: readonly GateRow[]): void {
  organization = metadata(rows);
  publishConnectors();
}
