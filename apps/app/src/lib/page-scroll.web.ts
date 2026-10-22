import { useSyncExternalStore } from 'react';

const TOP_SLACK = 48;

const readAtTop = (): boolean => window.scrollY < TOP_SLACK;

const subscribe = (listener: () => void): (() => void) => {
  window.addEventListener('scroll', listener, { passive: true });
  return () => {
    window.removeEventListener('scroll', listener);
  };
};

export function scrollPageToTop(): void {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

export const usePageAtTop = (): boolean => useSyncExternalStore(subscribe, readAtTop, () => true);
