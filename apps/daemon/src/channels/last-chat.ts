import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { readJson, writeSecure } from '@metro-labs/core/secure-fs';

export const LAST_CHAT_FILE = 'last-chat.json';

const LINE_MAX = 1_000;
const OLD_OWNER_CHAT = /^approval-line\.json(?:\.tmp-[0-9]+)?$/;

let file: string | undefined;
let known: string | undefined;

const isChatLine = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('metro://') && value.length <= LINE_MAX;

const parse = (raw: unknown): string | undefined =>
  isRecord(raw) && raw.version === 1 && isChatLine(raw.line) ? raw.line : undefined;

export function setLastChatFile(path: string): void {
  file = path;
  known = parse(readJson<unknown>(path, null, { warn: 'channels: the last chat file is not valid JSON, so it was ignored' }));
}

export const lastChat = (): string | undefined => known;

export function noteLastChat(line: string): void {
  if (file === undefined || line === known || !isChatLine(line)) return;
  known = line;
  try {
    writeSecure(file, `${JSON.stringify({ version: 1, line })}\n`);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'channels: the last chat could not be saved, so it is kept in memory only');
  }
}

export function forgetLastChat(): void {
  file = undefined;
  known = undefined;
}

const codeOf = (err: unknown): unknown => (err instanceof Error && 'code' in err ? err.code : undefined);

function removeOne(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) {
      log.warn({ path }, 'approvals: left the old owner chat file alone, it is not a regular file');
      return false;
    }
    unlinkSync(path);
    return true;
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') log.warn({ err: errMsg(err), path }, 'approvals: could not remove the old owner chat file');
    return false;
  }
}

export function removeOldOwnerChat(dir: string): number {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => OLD_OWNER_CHAT.test(name));
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') log.warn({ err: errMsg(err), dir }, 'approvals: could not look for the old owner chat file');
    return 0;
  }
  const removed = names.filter((name) => removeOne(join(dir, name))).length;
  if (removed > 0) log.info({ removed }, 'approvals: removed the old owner chat file, which nothing reads any more');
  return removed;
}
