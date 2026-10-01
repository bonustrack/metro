import { chmodSync, lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';

const CLI_PREFIX = '.npm-global';
const OPEN_BITS = 0o077;

function entryHolding(home: string, path: string): string | null {
  const rel = relative(home, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep)[0] ?? null;
}

function sharedEntries(home: string, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const cli = env.METRO_CLI_BIN?.trim() ?? '';
  const holding = cli === '' ? null : entryHolding(home, cli);
  return new Set(holding === null ? [CLI_PREFIX] : [CLI_PREFIX, holding]);
}

function closeEntry(path: string): boolean {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (stat.mode & OPEN_BITS) === 0) return false;
  chmodSync(path, stat.mode & 0o700);
  return true;
}

export function closeMetroHome(home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  chmodSync(home, 0o711);
  const shared = sharedEntries(home, env);
  const closed: string[] = [];
  for (const name of readdirSync(home)) {
    if (shared.has(name)) continue;
    try {
      if (closeEntry(join(home, name))) closed.push(name);
    } catch (err) {
      log.warn({ entry: name, err: errMsg(err) }, 'agent-user: could not close an entry of the metro home');
    }
  }
  if (closed.length > 0) log.info({ closed }, 'agent-user: closed entries of the metro home so the agent user cannot read them');
  return closed;
}
