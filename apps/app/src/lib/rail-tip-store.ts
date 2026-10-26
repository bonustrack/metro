import { useSyncExternalStore } from 'react';

interface RailTipState {
  label: string;
  shortcut?: string;
  x: number;
  y: number;
  side: 'right' | 'top';
}

let current: RailTipState | null = null;
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const read = (): RailTipState | null => current;

export function showRailTip(next: RailTipState): void {
  current = next;
  notify();
}

export function hideRailTip(): void {
  if (current === null) return;
  current = null;
  notify();
}

export const useRailTip = (): RailTipState | null => useSyncExternalStore(subscribe, read, read);
