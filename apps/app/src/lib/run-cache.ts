import { AuthError, ForbiddenError, NotFoundError } from '@metro-labs/client/api/client';
import type { QueryCache, QueryKey } from '@tanstack/react-query';

const PRIVATE_SOURCES = new Set(['run-events', 'claude-session', 'claude-account', 'model', 'stations']);

export const runAccessDenied = (error: unknown): boolean =>
  error instanceof AuthError || error instanceof ForbiddenError || error instanceof NotFoundError;

export function clearDeniedRunCache(cache: QueryCache, key: QueryKey, error: unknown): void {
  const [name, base] = key;
  if (!(error instanceof Error) || typeof name !== 'string' || !PRIVATE_SOURCES.has(name) || typeof base !== 'string' || !runAccessDenied(error)) return;
  for (const query of cache.findAll({ predicate: (row) =>
    row.queryKey[1] === base && typeof row.queryKey[0] === 'string' && PRIVATE_SOURCES.has(row.queryKey[0]) })) {
    query.reset();
    query.setState({ data: undefined, dataUpdatedAt: 0, error, errorUpdatedAt: Date.now(), status: 'error', fetchStatus: 'idle' });
  }
}
