import { type ReactElement } from 'react';
import { Path, Svg } from 'react-native-svg';

export function MenuIcon({ size = 22, color }: { size?: number; color: string }): ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 6h16M4 12h16M4 18h7"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
