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
