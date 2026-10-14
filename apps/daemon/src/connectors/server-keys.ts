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

const sameKeys = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean =>
  a.size === b.size && [...a].every(([id, key]) => b.get(id) === key);

function serverKeyFiles(dir = agentsDir()): { path: string; marker: string } {
  return { path: join(dir, 'connector-server-keys.json'), marker: join(dir, 'connector-server-keys.initialized') };
}

export function readServerKeys(dir = agentsDir()): Map<string, string> | undefined {
  const { path, marker } = serverKeyFiles(dir);
  return readKeys(path, marker);
}

export function writeServerKeys(keys: ReadonlyMap<string, string>, dir = agentsDir()): void {
  const { path, marker } = serverKeyFiles(dir);
  if (!existsSync(marker)) writeSecure(marker, '1\n');
  writeSecure(path, `${JSON.stringify({ version: 1, keys: Object.fromEntries(keys) }, null, 2)}\n`);
}

export function persistentServerKeys(rows: PluginRow[], dir = agentsDir()): Map<string, string> {
  const saved = readServerKeys(dir);
  const keys = serverKeysOf(rows, saved);
  if (saved === undefined ? keys.size > 0 : !sameKeys(saved, keys)) writeServerKeys(keys, dir);
  return keys;
}
