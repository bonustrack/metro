import { createHash } from 'node:crypto';
import type { AgentKey } from './agent-key.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectorSyncStatus } from '@metro-labs/core/connector-sync';
import { isRecord } from '@metro-labs/core/is-record';
import { writeSecure } from '@metro-labs/core/secure-fs';
import { ApiError } from '@metro-labs/http/api-error';

interface SavedSetting {
  version: 1;
  enabled: boolean;
  scope: string;
}

type Stored = SavedSetting | 'absent' | 'invalid';
const pathOf = (dir: string): string => join(dir, 'org-connector-sync.json');

function read(dir: string): Stored {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(pathOf(dir), 'utf8')) as unknown;
  } catch (err) {
    return isRecord(err) && err.code === 'ENOENT' ? 'absent' : 'invalid';
  }
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.enabled !== 'boolean' || typeof raw.scope !== 'string' || !/^[a-f0-9]{64}$/.test(raw.scope)) return 'invalid';
  return { version: 1, enabled: raw.enabled, scope: raw.scope };
}

export function connectorSyncScope(owner: string | null, key: AgentKey | null): string {
  const agentId = owner !== null && key?.enrollment?.organization === owner ? key.enrollment.server : null;
  return createHash('sha256').update(JSON.stringify([owner, agentId, key?.keyId ?? null, key?.sealingKey ?? null])).digest('hex');
}

export function syncOptedIn(dir: string): boolean {
  const saved = read(dir);
  if (saved === 'absent') return process.env.METRO_CONNECTORS_SYNC_ENABLED === 'true';
  return saved !== 'invalid' && saved.enabled;
}

export function syncSetting(dir: string, scope: string): Pick<ConnectorSyncStatus, 'enabled' | 'source'> {
  const saved = read(dir);
  if (saved === 'invalid') return { enabled: false, source: 'invalid' };
  if (saved === 'absent') return process.env.METRO_CONNECTORS_SYNC_ENABLED === 'true' ? { enabled: true, source: 'environment' } : { enabled: false, source: 'default' };
  if (saved.scope !== scope) return { enabled: false, source: 'scope_changed' };
  return { enabled: saved.enabled, source: 'saved' };
}

export function saveSyncSetting(dir: string, enabled: boolean, scope: string): void {
  try {
    writeSecure(pathOf(dir), `${JSON.stringify({ version: 1, enabled, scope })}\n`);
  } catch {
    throw new ApiError('Metro could not save the connector sync setting.', 503);
  }
}

export function disableSavedSync(dir: string): void {
  const saved = read(dir);
  if (typeof saved !== 'string' && saved.enabled) saveSyncSetting(dir, false, saved.scope);
}
