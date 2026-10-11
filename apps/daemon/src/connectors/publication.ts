import { registerConnectors, type GateRow } from './gates.js';
import { syncPluginServers } from './plugin-sync.js';
import { isOrgRelayId } from './relay-id.js';

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
  const rows = [...local, ...organization];
  registerConnectors(rows);
  syncPluginServers(rows);
}

export function publishLocalConnectors(rows: readonly GateRow[]): void {
  local = metadata(rows.filter((row) => !isOrgRelayId(row.id)));
  publishConnectors();
}

export function publishOrgConnectors(rows: readonly GateRow[]): void {
  organization = metadata(rows.filter((row) => isOrgRelayId(row.id)));
  publishConnectors();
}
