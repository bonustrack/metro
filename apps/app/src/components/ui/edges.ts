import type { ResolvedBoxBorder } from '@stage-labs/kit/layout';

export const side = (color: string, width = 1): { width: number; color: string } => ({ width, color });

export const allSides = (color: string, width = 1): ResolvedBoxBorder => {
  const s = side(color, width);
  return { top: s, right: s, bottom: s, left: s };
};
