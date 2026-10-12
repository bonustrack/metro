import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import { writeSecure } from '@metro-labs/core/secure-fs';
import { agentsDir } from '../agents/files.js';
import { serverKeysOf, type PluginRow } from './plugin-sync.js';

const invalid = (): Error => new Error('Invalid connector server keys. Restore the saved namespace mapping and initialization marker.');

function readKeys(path: string, marker: string): Map<string, string> | undefined {
  try {
    const marked = existsSync(marker);
    if (marked && readFileSync(marker, 'utf8') !== '1\n') throw invalid();
    if (!existsSync(path)) {
      if (marked) throw invalid();
      return undefined;
    }
    if (!marked) throw invalid();
    return parseKeys(readFileSync(path, 'utf8'));
  } catch { throw invalid(); }
}

function parseKeys(text: string): Map<string, string> {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.keys)) throw invalid();
  const keys = new Map<string, string>();
  const reserved = new Set<string>();
  for (const [id, key] of Object.entries(raw.keys)) {
    if (typeof key !== 'string' || !/^[a-z0-9-]+$/.test(key) || reserved.has(key)) throw invalid();
    reserved.add(key);
    keys.set(id, key);
  }
  return keys;
}

export function persistentServerKeys(rows: PluginRow[], dir = agentsDir(), published: PluginRow[] = rows): Map<string, string> {
  const path = join(dir, 'connector-server-keys.json');
  const marker = join(dir, 'connector-server-keys.initialized');
  const saved = readKeys(path, marker);
  const keys = serverKeysOf(rows, saved, published);
  if (keys.size > 0 && keys.size !== saved?.size) {
    if (saved === undefined) writeSecure(marker, '1\n');
    writeSecure(path, `${JSON.stringify({ version: 1, keys: Object.fromEntries(keys) }, null, 2)}\n`);
  }
  return keys;
}
