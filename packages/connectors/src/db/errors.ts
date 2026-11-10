import { isRecord } from '@metro-labs/core/is-record';
import { errMsg } from '@metro-labs/core/log';

const MESSAGE_MAX = 200;
const UNIQUE_VIOLATION = '23505';
const UNDEFINED_TABLE = '42P01';
const UNDEFINED_COLUMN = '42703';
const DEPTH = 4;

function hasCode(err: unknown, code: string): boolean {
  let current: unknown = err;
  for (let i = 0; i < DEPTH && isRecord(current); i += 1) {
    if (current.code === code) return true;
    current = current.cause;
  }
  return false;
}

export const isUniqueViolation = (err: unknown): boolean => hasCode(err, UNIQUE_VIOLATION);

export const isUndefinedTable = (err: unknown): boolean => hasCode(err, UNDEFINED_TABLE);

export const isNotMigrated = (err: unknown): boolean => hasCode(err, UNDEFINED_TABLE) || hasCode(err, UNDEFINED_COLUMN);

export function failureText(err: unknown): string {
  let current: unknown = err;
  for (let i = 0; i < DEPTH && isRecord(current); i += 1) {
    if (typeof current.code === 'string' && typeof current.message === 'string') return `${current.code}: ${current.message.slice(0, MESSAGE_MAX)}`;
    current = current.cause;
  }
  const text = errMsg(err);
  return text.startsWith('Failed query') ? 'a database query failed' : text.slice(0, MESSAGE_MAX);
}
