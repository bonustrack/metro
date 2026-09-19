import { isRecord } from '@metro-labs/core/is-record';

const UNIQUE_VIOLATION = '23505';
const DEPTH = 4;

export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let i = 0; i < DEPTH && isRecord(current); i += 1) {
    if (current.code === UNIQUE_VIOLATION) return true;
    current = current.cause;
  }
  return false;
}
