import { type ReactElement } from 'react';
import { Path, Svg } from 'react-native-svg';

export function CloseIcon({ size = 20, color }: { size?: number; color: string }): ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M6 6l12 12M18 6L6 18"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </Svg>
  );
}
