import { useMemo } from 'react';
import { PanResponder, type GestureResponderHandlers } from 'react-native';
import { EDGE, swipeVerdict } from './swipe-verdict.js';

const START = 10;

export function useSwipeDrawer(active: boolean, open: boolean, set: (open: boolean) => void): GestureResponderHandlers {
  return useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_e, g) =>
          active && Math.abs(g.dx) > Math.abs(g.dy) && (open ? g.dx < -START : g.x0 <= EDGE && g.dx > START),
        onPanResponderRelease: (_e, g) => {
          const verdict = swipeVerdict({ x: g.x0, y: g.y0 }, { x: g.moveX, y: g.moveY }, open);
          if (verdict === 'open') set(true);
          if (verdict === 'close') set(false);
        },
      }).panHandlers,
    [active, open, set],
  );
}
