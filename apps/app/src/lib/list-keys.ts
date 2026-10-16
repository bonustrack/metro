import { useEffect, useRef, useState } from 'react';

export interface ListStep {
  cursor: number | null;
  open: number | null;
}

function moved(cursor: number | null, by: number, count: number, start: number): number {
  if (cursor === null && start < 0) return 0;
  return Math.min(count - 1, Math.max(0, (cursor ?? start) + by));
}

export function listStep(cursor: number | null, key: string, count: number, start: number): ListStep | null {
  if (count === 0) return null;
  if (key === 'j' || key === 'k') return { cursor: moved(cursor, key === 'j' ? 1 : -1, count, start), open: null };
  if (cursor === null) return null;
  if (key === 'Enter') return { cursor, open: cursor };
  return key === 'Escape' ? { cursor: null, open: null } : null;
}

function typing(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function useListKeys(count: number, start: number, onOpen: (at: number) => void, enabled: boolean): number | null {
  const [cursor, setCursor] = useState<number | null>(null);
  const latest = useRef({ cursor, count, start, onOpen });
  useEffect(() => {
    latest.current = { cursor, count, start, onOpen };
  });
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      const now = latest.current;
      const step = listStep(now.cursor, event.key.length === 1 ? event.key.toLowerCase() : event.key, now.count, now.start);
      if (step === null) return;
      event.preventDefault();
      setCursor(step.open === null ? step.cursor : null);
      if (step.open !== null) now.onOpen(step.open);
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [enabled]);
  return cursor;
}
