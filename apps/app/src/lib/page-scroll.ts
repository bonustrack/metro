import { useSyncExternalStore } from 'react';

const TOP_SLACK = 48;

const listeners = new Set<() => void>();
let atTop = true;
let toTop: (() => void) | null = null;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const readAtTop = (): boolean => atTop;

export function notePageOffset(offset: number): void {
  const next = offset < TOP_SLACK;
  if (next === atTop) return;
  atTop = next;
  for (const listener of listeners) listener();
}

export function setPageScroller(scroll: (() => void) | null): void {
  toTop = scroll;
  if (scroll === null) notePageOffset(0);
}

export function scrollPageToTop(): void {
  toTop?.();
}

export const usePageAtTop = (): boolean => useSyncExternalStore(subscribe, readAtTop, readAtTop);
