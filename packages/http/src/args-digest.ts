import { createHash } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((name) => [name, canonical(value[name])]));
}

export const canonicalJson = (value: unknown): string => JSON.stringify(canonical(value)) ?? 'null';

export const argsDigest = (args: Record<string, unknown>): string => createHash('sha256').update(canonicalJson(args), 'utf8').digest('base64url');
