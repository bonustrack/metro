import { createHash } from 'node:crypto';
import type { MigrationPayload } from '@metro-labs/http/connector-migration';
import { connectorPolicyOf } from '@metro-labs/http/connector-delivery';
import { ApiError } from '@metro-labs/http/api-error';
import { boundOAuthResource } from '@metro-labs/http/connector-public-url';
import type { LocalConnectorRow } from './store.js';

export function migrationPayload(row: LocalConnectorRow, oauthResource?: string): MigrationPayload {
  const oauth = row.config.oauth || row.config.auth.kind === 'oauth';
  const auth = oauth ? { kind: 'oauth' as const } : row.config.auth;
  if (!oauth && oauthResource !== undefined) throw new ApiError('Only an OAuth connector accepts a public OAuth resource.', 400);
  return stamped({
    name: row.name, url: row.url, auth, client: row.config.client, policy: connectorPolicyOf(row.config.policy ?? {}),
    ...(oauthResource === undefined ? {} : { oauthResource: boundOAuthResource(row.url, oauthResource) }),
  });
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
