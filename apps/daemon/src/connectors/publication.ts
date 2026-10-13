import { registerConnectors, type GateRow } from './gates.js';
import { syncPluginServers } from './plugin-sync.js';
import { persistentServerKeys } from './server-keys.js';
import { isOrgRelayId } from './relay-id.js';
import { migrationRecords } from './migration-state.js';

let local: GateRow[] = [];
let organization: GateRow[] | null = null;

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

function publishedRows(records: ReturnType<typeof migrationRecords>, organization: GateRow[]): GateRow[] {
  const retired = new Set(records.filter((record) => !['preparing', 'prepared'].includes(record.phase)).map((record) => record.sourceId));
  const aliases = new Map(organization.filter((row) => records.some((record) => record.phase === 'active' && record.sourceId === row.id && record.name === row.name)).map((row) => [row.id, row]));
  const rows = local.flatMap((row) => {
    const alias = aliases.get(row.id);
    return alias !== undefined ? [alias] : retired.has(row.id) ? [] : [row];
  });
  rows.push(...organization.filter((row) => isOrgRelayId(row.id) && !records.some((record) => row.id === `org-${record.destinationId ?? ''}`)));
  return rows;
}

export function publishConnectors(): void {
  let rows: GateRow[];
  let keys: Map<string, string>;
  try {
    const records = migrationRecords().filter((record) => record.phase !== 'rolled_back');
    if (organization === null && records.some((record) => record.phase === 'active')) return;
    const org = organization ?? [];
    rows = publishedRows(records, org);
    const active = new Set(records.filter((record) => record.phase === 'active').map((record) => record.sourceId));
    const reserved = [...rows, ...local.filter((row) => active.has(row.id))];
    keys = persistentServerKeys([...local, ...org.filter((row) => isOrgRelayId(row.id))], undefined, reserved);
  }
  catch (error) {
    registerConnectors([]);
    syncPluginServers([]);
    throw error;
  }
  registerConnectors(rows, keys);
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
