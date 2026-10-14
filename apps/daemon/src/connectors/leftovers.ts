import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { agentsDir } from '../agents/files.js';

const WRITTEN = new Set([
  'connectors.json',
  'connector-migrations.json',
  'connector-migrations.initialized',
  'connector-server-keys.json',
  'connector-server-keys.initialized',
  'org-connector-sync.json',
]);

const OPERATIONS = 'connector-migration-operations-[A-Za-z0-9][A-Za-z0-9_-]{10}\\.json';

const PATTERNS = [
  new RegExp(`^${OPERATIONS}(?:\\.initialized)?$`),
  new RegExp(`^(?:connectors\\.json|connector-server-keys\\.json|connector-server-keys\\.initialized|org-connector-sync\\.json|${OPERATIONS})\\.tmp-[0-9]+$`),
  /^connector-migrations\.json\.[0-9a-f]{24}\.tmp$/,
];

const isConnectorLeftover =(name: string): boolean => WRITTEN.has(name) || PATTERNS.some((pattern) => pattern.test(name));

const codeOf = (err: unknown): unknown => (err instanceof Error && 'code' in err ? err.code : undefined);

function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter(isConnectorLeftover);
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') log.warn({ err: errMsg(err), dir }, 'connectors: could not list the old connector files');
    return [];
  }
}

function removeOne(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) {
      log.warn({ path }, 'connectors: left an old connector file alone, it is not a regular file');
      return false;
    }
    unlinkSync(path);
    return true;
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') log.warn({ err: errMsg(err), path }, 'connectors: could not remove an old connector file');
    return false;
  }
}

export function removeConnectorLeftovers(dir = agentsDir()): number {
  try {
    const removed = namesIn(dir).filter((name) => removeOne(join(dir, name))).length;
    log.info({ removed }, 'connectors: removed the files of the old connector path');
    return removed;
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'connectors: could not remove the files of the old connector path');
    return 0;
  }
}
