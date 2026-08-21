import { useCallback, useEffect, useRef, useState } from 'react';
import { carryForward } from './accounts';
import { fetchStations, type StationsView } from './client';
import { loadError } from '../load';

const FALLBACK = 'Could not load your stations.';

export interface LoadedStations {
  data: StationsView | null;
  error: string | null;
  reload: (dropped?: string[]) => void;
}

export function useStations(token: string): LoadedStations {
  const [data, setData] = useState<StationsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);

  const reload = useCallback(
    (dropped: string[] = []): void => {
      const id = ++attempt.current;
      fetchStations(token)
        .then((next) => {
          if (id !== attempt.current) return;
          setData((prev) => ({
            ...next,
            groups: carryForward(
              next.groups,
              prev?.groups ?? [],
              next.unavailable,
              dropped,
            ),
          }));
          setError(null);
        })
        .catch((err: unknown) => {
          if (id !== attempt.current) return;
          setError(loadError(err, FALLBACK));
        });
    },
    [token],
  );

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, reload };
}
