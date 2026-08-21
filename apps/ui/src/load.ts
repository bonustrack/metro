import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthError } from './api/client';

const EXPIRED = 'Your Metro session expired. Reload the page to sign in again.';

export function loadError(err: unknown, fallback: string): string {
  if (err instanceof AuthError) return EXPIRED;
  return err instanceof Error ? err.message : fallback;
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  reload: () => void;
}

export function useLoad<T>(
  load: () => Promise<T>,
  fallback: string,
): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);

  const run = useCallback((): void => {
    const id = ++attempt.current;
    load()
      .then((next) => {
        if (id !== attempt.current) return;
        setData(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (id !== attempt.current) return;
        setError(loadError(err, fallback));
      });
  }, [load, fallback]);

  useEffect(run, [run]);

  return { data, error, reload: run };
}
