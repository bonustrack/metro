import { useSyncExternalStore } from 'react';
import { readItem, writeItem } from '@metro-labs/client/platform';

const KEY = 'metro.technical';
const listeners = new Set<() => void>();

export const technicalDetails = (): boolean => readItem(KEY) === 'on';

export function setTechnicalDetails(on: boolean): void {
  writeItem(KEY, on ? 'on' : null);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTechnicalDetails(): boolean {
  return useSyncExternalStore(subscribe, technicalDetails, technicalDetails);
}
