import { type ReactElement } from 'react';
import { Rect, Svg } from 'react-native-svg';

const TILE = 10;
const GAP = 1;

export function MicrosoftMark({ size }: { size: number }): ReactElement {
  const far = TILE + GAP;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${String(far + TILE)} ${String(far + TILE)}`}>
      <Rect x={0} y={0} width={TILE} height={TILE} fill="#F25022" />
      <Rect x={far} y={0} width={TILE} height={TILE} fill="#7FBA00" />
      <Rect x={0} y={far} width={TILE} height={TILE} fill="#00A4EF" />
      <Rect x={far} y={far} width={TILE} height={TILE} fill="#FFB900" />
    </Svg>
  );
}
