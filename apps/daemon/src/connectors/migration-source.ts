import { createHash } from 'node:crypto';
import type { MigrationPayload } from '@metro-labs/http/connector-migration';
import { connectorPolicyOf } from '@metro-labs/http/connector-delivery';
import type { LocalConnectorRow } from './store.js';

export function migrationPayload(row: LocalConnectorRow): MigrationPayload {
  const oauth = row.config.oauth || row.config.auth.kind === 'oauth';
  const auth = oauth ? { kind: 'oauth' as const } : row.config.auth;
  if (auth.kind === 'oauth') {
    return stamped({ name: row.name, url: row.url, auth: { kind: 'oauth' }, client: row.config.client, policy: connectorPolicyOf(row.config.policy ?? {}) });
  }
  return stamped({ name: row.name, url: row.url, auth, client: row.config.client, policy: connectorPolicyOf(row.config.policy ?? {}) });
}

function stamped(value: Omit<MigrationPayload, 'sourceStamp'>): MigrationPayload {
  const policy = value.policy;
  const canonical = {
    ...value,
    policy: { read: policy.read ?? 'allow', write: policy.write ?? 'allow', tools: Object.entries(policy.tools ?? {}).sort(([a], [b]) => a.localeCompare(b)) },
  };
  const sourceStamp = createHash('sha256').update(JSON.stringify(canonical)).digest('base64url');
  return { ...value, sourceStamp };
}
