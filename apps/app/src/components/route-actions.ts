import { useState } from 'react';
import type { ModelRoute } from '@metro-labs/client/api/model-route';
import { movedFallback, promotedFallback, removedFallback, type Slot } from '@metro-labs/client/api/route-edit';
import { queryError } from '../lib/queries.js';

export interface RouteActions {
  edit: (slot: Slot) => void;
  move: (at: number, by: number) => void;
  promote: (at: number) => void;
  remove: (at: number) => void;
}

export interface RouteControl {
  busy: boolean;
  error: string | null;
  slot: Slot | null;
  close: () => void;
  run: (job: () => Promise<void>, fallback: string) => void;
  actions: RouteActions;
}

export function useRouteControl(route: ModelRoute | null, save: (route: ModelRoute) => Promise<void>): RouteControl {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const run = (job: () => Promise<void>, fallback: string): void => {
    setError(null);
    setBusy(true);
    job()
      .catch((err: unknown) => {
        setError(queryError(err, fallback));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const change = (next: (current: ModelRoute) => ModelRoute, fallback: string): void => {
    if (route !== null) run(() => save(next(route)), fallback);
  };
  return {
    busy,
    error,
    slot,
    close: () => { setSlot(null); },
    run,
    actions: {
      edit: setSlot,
      move: (at, by) => { change((r) => movedFallback(r, at, by), 'Could not move the model.'); },
      promote: (at) => { change((r) => promotedFallback(r, at), 'Could not make it the main model.'); },
      remove: (at) => { change((r) => removedFallback(r, at), 'Could not remove the model.'); },
    },
  };
}
