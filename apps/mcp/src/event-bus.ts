import type { MetroEvent } from './events.js';

export type BusListener = (event: MetroEvent) => void;

const listeners = new Set<BusListener>();

export function publishEvent(event: MetroEvent): void {
  for (const fn of [...listeners]) {
    try {
      fn(event);
    } catch {
    }
  }
}

export function subscribeEvents(fn: BusListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
