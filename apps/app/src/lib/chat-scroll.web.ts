import { useEffect, useRef } from 'react';

const NEAR_BOTTOM = 200;

const nearBottom = (): boolean => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - NEAR_BOTTOM;

export function useStickToBottom(change: unknown): void {
  const first = useRef(true);
  const stick = useRef(true);
  useEffect(() => {
    const note = (): void => {
      stick.current = nearBottom();
    };
    window.addEventListener('scroll', note, { passive: true });
    return () => {
      window.removeEventListener('scroll', note);
    };
  }, []);
  useEffect(() => {
    if (!stick.current && !first.current) return;
    first.current = false;
    window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [change]);
}
