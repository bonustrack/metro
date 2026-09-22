export interface SenderProfile {
  from_name?: string;
  from_display_name?: string;
  from_avatar?: string;
  from_about?: string;
}

export interface ProfileCacheOptions {
  ttlMs?: number;
  max?: number;
  timeoutMs?: number;
  onError: (key: string, err: unknown) => void;
}

export interface ProfileCache<T> {
  get(key: string): Promise<T | null>;
  within(key: string, ms?: number): Promise<T | null>;
}

const TTL_MS = 10 * 60_000;
const MAX = 2000;
const TIMEOUT_MS = 3000;

interface Held<T> {
  at: number;
  value: Promise<T | null>;
}

export const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

export function makeProfileCache<T>(lookup: (key: string) => Promise<T | null>, opts: ProfileCacheOptions): ProfileCache<T> {
  const ttl = opts.ttlMs ?? TTL_MS;
  const max = opts.max ?? MAX;
  const cache = new Map<string, Held<T>>();
  const get = (key: string): Promise<T | null> => {
    const held = cache.get(key);
    if (held !== undefined && Date.now() - held.at < ttl) return held.value;
    const value = lookup(key).catch((err: unknown) => {
      opts.onError(key, err);
      cache.delete(key);
      return null;
    });
    cache.set(key, { at: Date.now(), value });
    while (cache.size > max) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
    return value;
  };
  const within = (key: string, ms = opts.timeoutMs ?? TIMEOUT_MS): Promise<T | null> => {
    const wait = new Promise<null>((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, ms).unref();
    });
    return Promise.race([get(key), wait]);
  };
  return { get, within };
}
