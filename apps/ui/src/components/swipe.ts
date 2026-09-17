import { useEffect } from 'react';

export const EDGE = 32;
export const SWIPE = 60;
const DRIFT = 40;

export interface Point {
  x: number;
  y: number;
}

export type SwipeVerdict = 'open' | 'close' | null;

export function swipeVerdict(from: Point, to: Point, open: boolean): SwipeVerdict {
  const dx = to.x - from.x;
  const dy = Math.abs(to.y - from.y);
  if (dy > DRIFT && dy > Math.abs(dx)) return null;
  if (!open) return from.x <= EDGE && dx >= SWIPE ? 'open' : null;
  return dx <= -SWIPE ? 'close' : null;
}

const pointOf = (touch: Touch | undefined): Point | null => (touch === undefined ? null : { x: touch.clientX, y: touch.clientY });

export function useSwipeDrawer(active: boolean, open: boolean, set: (open: boolean) => void): void {
  useEffect(() => {
    if (!active) return undefined;
    let from: Point | null = null;
    const start = (e: TouchEvent): void => {
      from = pointOf(e.touches[0]);
    };
    const end = (e: TouchEvent): void => {
      const to = pointOf(e.changedTouches[0]);
      if (from === null || to === null) return;
      const verdict = swipeVerdict(from, to, open);
      from = null;
      if (verdict === 'open') set(true);
      if (verdict === 'close') set(false);
    };
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchend', end, { passive: true });
    return () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchend', end);
    };
  }, [active, open, set]);
}
