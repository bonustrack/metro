import { createHash } from 'node:crypto';
import { errMsg, log } from '@metro-labs/core/log';

export const LIST_TTL_MS = 60 * 60_000;
export const RETRY_MS = 5 * 60_000;

export interface ListCache<T> {
  get: (key: string, load: () => Promise<T[]>) => Promise<T[]>;
  peek: (key: string) => T[] | null;
  refresh: (key: string, load: () => Promise<T[]>) => Promise<void>;
}

const clears = new Set<() => void>();

export function listCache<T>(name: string, now: () => number = Date.now): ListCache<T> {
  const kept = new Map<string, { at: number; list: T[] }>();
  const tried = new Map<string, number>();
  clears.add(() => {
    kept.clear();
    tried.clear();
  });
  const fresh = (key: string): boolean => {
    const hit = kept.get(key);
    return hit !== undefined && now() - hit.at < LIST_TTL_MS;
  };
  return {
    async get(key, load) {
      const hit = kept.get(key);
      if (hit !== undefined && fresh(key)) return hit.list;
      try {
        const list = await load();
        kept.set(key, { at: now(), list });
        return list;
      } catch (err) {
        if (hit === undefined) throw err;
        log.warn({ list: name, err: errMsg(err) }, 'model-lists: the provider would not list its models, so the last list it gave stands');
        return hit.list;
      }
    },
    peek: (key) => kept.get(key)?.list ?? null,
    async refresh(key, load) {
      if (fresh(key) || now() - (tried.get(key) ?? Number.NEGATIVE_INFINITY) < RETRY_MS) return;
      tried.set(key, now());
      try {
        kept.set(key, { at: now(), list: await load() });
      } catch (err) {
        log.warn({ list: name, err: errMsg(err) }, 'model-lists: the provider would not list its models, so the last list it gave stands');
      }
    },
  };
}

export function forgetModelLists(): void {
  for (const clear of clears) clear();
}

export const fingerprint = (...parts: string[]): string => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
