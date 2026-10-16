import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export const openJump = (): void => { set(true); };

export const closeJump = (): void => { set(false); };

export const toggleJump = (): void => { set(!open); };

const isOpen = (): boolean => open;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const useJumpOpen = (): boolean => useSyncExternalStore(subscribe, isOpen, isOpen);
