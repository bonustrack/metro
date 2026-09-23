import { readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../log.js';

export interface AccountFiles {
  path: (accountId: string) => string;
  forget: (accountId: string) => void;
  forgetExcept: (keptAccountIds: readonly string[]) => void;
}

const safeSegment = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_');

function listed(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function accountFiles(dirEnv: string, prefix: string): AccountFiles {
  const dir = (): string => process.env[dirEnv] ?? join(homedir(), '.metro');
  const name = (accountId: string): string => `${prefix}${safeSegment(accountId)}.json`;
  const remove = (file: string, reason: string): void => {
    rmSync(join(dir(), file), { force: true });
    log.info({ file: join(dir(), file) }, reason);
  };
  return {
    path: (accountId) => join(dir(), name(accountId)),
    forget: (accountId) => {
      remove(name(accountId), 'station: removed the files of a detached account');
    },
    forgetExcept: (keptAccountIds) => {
      const kept = new Set(keptAccountIds.map(name));
      for (const file of listed(dir()))
        if (file.startsWith(prefix) && file.endsWith('.json') && !kept.has(file))
          remove(file, 'station: removed the files of an account that is no longer attached');
    },
  };
}
