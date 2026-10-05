import { readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { accountFiles, type AccountFiles } from '@metro-labs/core/stations/account-files';
import { isRecord } from '@metro-labs/core/is-record';

const files = accountFiles('WHATSAPP_TOKEN_DIR', 'whatsapp-history-');
const TEMP_NAME = /^(whatsapp-history-[A-Za-z0-9_-]*\.json)\.tmp-[1-9]\d*$/;

function cleanTemps(dir: string, remove: (name: string) => boolean): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (isRecord(err) && err.code === 'ENOENT') return;
    throw err;
  }
  for (const name of names) {
    const original = TEMP_NAME.exec(name)?.[1];
    if (original && remove(original)) rmSync(join(dir, name), { force: true });
  }
}

export function clearHistoryTemps(path: string): void {
  const name = basename(path);
  cleanTemps(dirname(path), (original) => original === name);
}

export const historyFiles: AccountFiles = {
  path: files.path,
  forget(accountId) {
    files.forget(accountId);
    clearHistoryTemps(files.path(accountId));
  },
  forgetExcept(keptAccountIds) {
    files.forgetExcept(keptAccountIds);
    const kept = new Set(keptAccountIds.map((id) => basename(files.path(id))));
    cleanTemps(dirname(files.path('')), (original) => !kept.has(original));
  },
};
