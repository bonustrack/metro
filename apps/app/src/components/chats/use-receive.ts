import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { setAccountEnabled } from '@metro-labs/client/api/attach';
import { queryError, refresh } from '../../lib/queries.js';

export interface Receive {
  receiving: (station: string, id: string, enabled: boolean) => boolean;
  busy: (station: string, id: string) => boolean;
  error: string | null;
  toggle: (station: string, id: string, next: boolean) => void;
}

const keyOf = (station: string, id: string): string => `${station}/${id}`;

export function useReceive(agentId: string | undefined): Receive {
  const client = useQueryClient();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const settle = (key: string): void => {
    setPending((now) => Object.fromEntries(Object.entries(now).filter(([k]) => k !== key)));
  };
  return {
    receiving: (station, id, enabled) => pending[keyOf(station, id)] ?? enabled,
    busy: (station, id) => keyOf(station, id) in pending,
    error,
    toggle: (station, id, next) => {
      if (agentId === undefined) return;
      const key = keyOf(station, id);
      setPending((now) => ({ ...now, [key]: next }));
      setError(null);
      setAccountEnabled(agentId, station, id, next)
        .then(() => refresh(client, 'stations'))
        .catch((err: unknown) => {
          setError(queryError(err, next ? 'Could not turn receiving on.' : 'Could not turn receiving off.'));
        })
        .finally(() => {
          settle(key);
        });
    },
  };
}
