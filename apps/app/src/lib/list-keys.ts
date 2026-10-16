import { useEffect, useRef, useState } from 'react';

export interface ListStep {
  cursor: number | null;
  open: number | null;
}

interface KeyPress {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

interface Page {
  querySelector: (selector: string) => unknown;
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

export const plainKey = (press: KeyPress): string | null => (press.shiftKey || press.metaKey || press.ctrlKey || press.altKey ? null : press.key);

export const dialogOpen = (page: Page | undefined): boolean => page !== undefined && page.querySelector('[aria-modal="true"]') !== null;

function typing(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

const currentPage = (): Page | undefined => (typeof document === 'undefined' ? undefined : document);

export function useListKeys(count: number, start: number, onOpen: (at: number) => void, enabled: boolean, order: string): number | null {
  const [mark, setMark] = useState<{ at: number | null; order: string }>({ at: null, order });
  const cursor = mark.order === order ? mark.at : null;
  const latest = useRef({ cursor, count, start, onOpen, order });
  useEffect(() => {
    latest.current = { cursor, count, start, onOpen, order };
  });
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
    const onKey = (event: KeyboardEvent): void => {
      const key = plainKey(event);
      if (key === null || typing(event.target) || dialogOpen(currentPage())) return;
      const now = latest.current;
      const step = listStep(now.cursor, key.length === 1 ? key.toLowerCase() : key, now.count, now.start);
      if (step === null) return;
      event.preventDefault();
      setMark({ at: step.open === null ? step.cursor : null, order: now.order });
      if (step.open !== null) now.onOpen(step.open);
    };
    const onPointer = (): void => {
      setMark({ at: null, order: latest.current.order });
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [enabled]);
  return cursor;
}
