import { useCallback, useState } from 'react';
import { Platform } from 'react-native';
import { openExternal } from '../lib/open.js';
import { useQueryClient } from '@tanstack/react-query';
import { queryError, refresh } from '../lib/queries.js';

export async function inNewTab<T>(begin: () => Promise<T>, urlOf: (started: T) => string, blocked: (url: string) => void): Promise<T> {
  if (Platform.OS !== 'web') {
    const started = await begin();
    openExternal(urlOf(started));
    return started;
  }
  const tab = window.open('', '_blank');
  try {
    const started = await begin();
    if (tab === null) blocked(urlOf(started));
    else tab.location.assign(urlOf(started));
    return started;
  } catch (err) {
    tab?.close();
    throw err;
  }
}

export interface SignInTab<T> {
  starting: boolean;
  started: T | null;
  link: string | null;
  error: string | null;
  start: () => void;
  settle: (error: string | null) => void;
}

export function useSignInTab<T>(begin: () => Promise<T>, urlOf: (started: T) => string, fallback: string): SignInTab<T> {
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState<T | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = (): void => {
    setStarting(true);
    setError(null);
    setLink(null);
    inNewTab(begin, urlOf, setLink)
      .then((value) => {
        setStarted(() => value);
      })
      .catch((err: unknown) => {
        setError(queryError(err, fallback));
      })
      .finally(() => {
        setStarting(false);
      });
  };
  const settle = useCallback((message: string | null): void => {
    setStarted(null);
    setError(message);
  }, []);
  return { starting, started, link, error, start, settle };
}

export function useModelAction(): { busy: boolean; error: string | null; run: (job: () => Promise<unknown>, fallback: string) => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (job: () => Promise<unknown>, fallback: string): void => {
    setBusy(true);
    setError(null);
    job()
      .then(() => refresh(client, 'model'))
      .catch((err: unknown) => {
        setError(queryError(err, fallback));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { busy, error, run };
}
