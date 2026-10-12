import { createHash } from 'node:crypto';
import type { MigrationPayload } from '@metro-labs/http/connector-migration';
import { connectorPolicyOf } from '@metro-labs/http/connector-delivery';
import { ApiError } from '@metro-labs/http/api-error';
import { portableGrant } from '@metro-labs/http/connector-grant';
import { boundOAuthResource } from '@metro-labs/http/connector-public-url';
import type { LocalConnectorRow } from './store.js';

export class MigrationBlocked extends ApiError {
  constructor(readonly reason: string, message: string) { super(message, 409); }
}

export function migrationPayload(row: LocalConnectorRow, oauthResource?: string, transfer = false): MigrationPayload {
  const oauth = row.config.oauth || row.config.auth.kind === 'oauth';
  const auth = sourceAuth(row, oauth, transfer);
  if (!oauth && oauthResource !== undefined) throw new ApiError('Only an OAuth connector accepts a public OAuth resource.', 400);
  return stamped({
    name: row.name, url: row.url, auth, client: row.config.client, policy: connectorPolicyOf(row.config.policy ?? {}),
    ...(oauthResource === undefined ? {} : { oauthResource: boundOAuthResource(row.url, oauthResource) }),
  });
}

function sourceAuth(row: LocalConnectorRow, oauth: boolean, transfer: boolean): MigrationPayload['auth'] {
  if (!oauth) return row.config.auth;
  return transfer ? { kind: 'oauth', grant: transferableGrant(row) } : { kind: 'oauth' };
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

function transferableGrant(row: LocalConnectorRow): ReturnType<typeof portableGrant> {
  if (row.config.auth.kind !== 'oauth') throw new MigrationBlocked('sign_in', 'This connector has no saved OAuth grant. Sign in locally before moving it.');
  try { return portableGrant(row.config.auth, row.url); }
  catch { throw new MigrationBlocked('unsupported_grant', 'This OAuth grant has unsupported client authentication or provider binding. Keep it local or sign in separately.'); }
}
