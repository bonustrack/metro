import { registerConnectors, type GateRow } from './gates.js';
import { syncPluginServers } from './plugin-sync.js';
import { persistentServerKeys } from './server-keys.js';

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

export function publishConnectors(): void {
  if (organization === null) return;
  let keys: Map<string, string>;
  try {
    keys = persistentServerKeys(organization);
  }
  catch (error) {
    registerConnectors([]);
    syncPluginServers([]);
    throw error;
  }
  registerConnectors(organization, keys);
  syncPluginServers(organization, { keys });
}

export function publishOrgConnectors(rows: readonly GateRow[]): void {
  organization = metadata(rows);
  publishConnectors();
}
