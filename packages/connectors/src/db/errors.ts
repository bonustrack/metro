import { isRecord } from '@metro-labs/core/is-record';

const UNIQUE_VIOLATION = '23505';
const UNDEFINED_TABLE = '42P01';
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
