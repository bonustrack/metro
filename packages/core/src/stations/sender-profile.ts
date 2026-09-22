export interface SenderProfile {
  id: string;
  name?: string;
  display_name?: string;
  about?: string;
  avatar?: string;
  address?: string;
}

export interface ProfileCacheOptions {
  ttlMs?: number;
  max?: number;
  onError: (key: string, err: unknown) => void;
}

export interface ProfileCache<T> {
  get(key: string): Promise<T | null>;
  peek(key: string): T | null;
}

const TTL_MS = 10 * 60_000;
const MAX = 2000;

interface Held<T> {
  at: number;
  value: Promise<T | null>;
  settled: T | null;
}

export const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

export function makeProfileCache<T>(lookup: (key: string) => Promise<T | null>, opts: ProfileCacheOptions): ProfileCache<T> {
  const ttl = opts.ttlMs ?? TTL_MS;
  const max = opts.max ?? MAX;
  const cache = new Map<string, Held<T>>();
  const fresh = (key: string): Held<T> | undefined => {
    const held = cache.get(key);
    return held !== undefined && Date.now() - held.at < ttl ? held : undefined;
  };
  const start = (key: string): Held<T> => {
    const held: Held<T> = { at: Date.now(), settled: null, value: Promise.resolve(null) };
    held.value = lookup(key)
      .then((value) => {
        held.settled = value;
        return value;
      })
      .catch((err: unknown) => {
        opts.onError(key, err);
        cache.delete(key);
        return null;
      });
    cache.set(key, held);
    while (cache.size > max) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
    return held;
  };
  return {
    get: (key) => (fresh(key) ?? start(key)).value,
    peek: (key) => (fresh(key) ?? start(key)).settled,
  };
}
