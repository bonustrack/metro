import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { agentsDir } from '../agents/files.js';
import { isOrgRelayId, orgRelayId } from './relay-id.js';
import { readServerKeys, writeServerKeys } from './server-keys.js';

interface Alias {
  sourceId: string;
  relayId: string;
}

function recordsOf(dir: string): unknown[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, 'connector-migrations.json'), 'utf8'));
  } catch (err) {
    if (isRecord(err) && err.code === 'ENOENT') return [];
    log.warn({ err: errMsg(err) }, 'connectors: the old migration records could not be read; server keys left as they are');
    return [];
  }
  if (isRecord(raw) && raw.version === 1 && Array.isArray(raw.records)) return raw.records;
  log.warn('connectors: the old migration records are not valid; server keys left as they are');
  return [];
}

function aliasOf(record: unknown): Alias[] {
  if (!isRecord(record) || record.phase !== 'active' || typeof record.sourceId !== 'string' || typeof record.destinationId !== 'string') return [];
  const relayId = orgRelayId(record.destinationId);
  return isOrgRelayId(relayId) && record.sourceId !== relayId ? [{ sourceId: record.sourceId, relayId }] : [];
}

export function adoptOrgServerKeys(dir = agentsDir()): number {
  try {
    const aliases = recordsOf(dir).flatMap(aliasOf);
    if (aliases.length === 0) return 0;
    const keys = readServerKeys(dir);
    if (keys === undefined) return 0;
    let moved = 0;
    for (const { sourceId, relayId } of aliases) {
      const key = keys.get(sourceId);
      if (key === undefined || keys.has(relayId)) continue;
      keys.delete(sourceId);
      keys.set(relayId, key);
      moved += 1;
    }
    if (moved > 0) {
      writeServerKeys(keys, dir);
      log.info({ moved }, 'connectors: server keys moved to organization connector ids, tool names unchanged');
    }
    return moved;
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'connectors: the server keys could not be moved to organization connector ids');
    return 0;
  }
}
