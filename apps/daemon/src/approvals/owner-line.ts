import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { readJson, writeSecure } from '@metro-labs/core/secure-fs';

export interface OwnerLine {
  line: string;
  from: string;
}

let file: string | undefined;
let known: OwnerLine | undefined;
let saved: string | undefined;

const textOf = (owner: OwnerLine): string => JSON.stringify({ line: owner.line, from: owner.from });

function parse(raw: unknown): OwnerLine | undefined {
  if (!isRecord(raw) || typeof raw.line !== 'string' || typeof raw.from !== 'string') return undefined;
  return raw.line.startsWith('metro://') && raw.from.startsWith('metro://') ? { line: raw.line, from: raw.from } : undefined;
}

export function setOwnerLineFile(path: string): void {
  file = path;
  known = parse(readJson<unknown>(path, null, { warn: 'approvals: the owner chat file is not valid JSON, so it was ignored' }));
  saved = known === undefined ? undefined : textOf(known);
}

export const ownerLine = (): OwnerLine | undefined => known;

export function noteOwnerLine(line: string, from: string): void {
  known = { line, from };
  const next = textOf(known);
  if (file === undefined || next === saved) return;
  try {
    writeSecure(file, `${next}\n`);
    saved = next;
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'approvals: the owner chat could not be saved, so it is kept in memory only');
  }
}

export function forgetOwnerLine(): void {
  file = undefined;
  known = undefined;
  saved = undefined;
}
