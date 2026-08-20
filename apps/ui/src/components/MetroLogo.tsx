import { type ReactElement } from 'react';
import { Path, Svg } from 'react-native-svg';

const METRO_LOGO_BARS = [
  'M18 20L25 20L25 4L18 4L18 20Z',
  'M7 20L14 20L14 4L7 4L7 20Z',
  'M23 28L30 28L30 20L23 20L23 28Z',
  'M12.5 28L19.5 28L19.5 20L12.5 20L12.5 28Z',
  'M2 28L9 28L9 20L2 20L2 28Z',
];

export interface MetroLogoProps {
  size?: number;
  color: string;
}

export function MetroLogo({ size = 32, color }: MetroLogoProps): ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      {METRO_LOGO_BARS.map((d) => (
        <Path key={d} d={d} fill={color} />
      ))}
    </Svg>
  );
}
