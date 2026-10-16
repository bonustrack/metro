import { useEffect } from 'react';

const TRIES_MS = [50, 400, 1_200];
const STOPS = ['wheel', 'touchstart', 'keydown', 'pointerdown'];

export function useScrollToAnchor(id: string | null): void {
  useEffect(() => {
    if (id === null || typeof document === 'undefined' || typeof window === 'undefined') return undefined;
    const timers = TRIES_MS.map((ms) =>
      setTimeout(() => {
        document.getElementById(id)?.scrollIntoView({ block: 'start' });
      }, ms),
    );
    const stop = (): void => {
      for (const timer of timers) clearTimeout(timer);
    };
    for (const name of STOPS) window.addEventListener(name, stop, { passive: true });
    return () => {
      stop();
      for (const name of STOPS) window.removeEventListener(name, stop);
    };
  }, [id]);
}
