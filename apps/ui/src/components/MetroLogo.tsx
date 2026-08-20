import { type ReactElement } from 'react';
import { Path, Svg } from 'react-native-svg';

const VIEW_WIDTH = 280;
const VIEW_HEIGHT = 240;

const METRO_LOGO_BARS = [
  'M159.999 160L229.999 160L230 6.70656e-05L159.999 5.57151e-05V160Z',
  'M50.001 160H120.001L120.001 1.13505e-05L50.001 0L50.001 160Z',
  'M210 240H280L280 160H210L210 240Z',
  'M105 240H175L175 160H105L105 240Z',
  'M0 240H70L70 160H1.31439e-05L0 240Z',
];

export interface MetroLogoProps {
  size?: number;
  color: string;
}

export function MetroLogo({ size = 24, color }: MetroLogoProps): ReactElement {
  return (
    <Svg
      width={(size * VIEW_WIDTH) / VIEW_HEIGHT}
      height={size}
      viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
    >
      {METRO_LOGO_BARS.map((d) => (
        <Path key={d} d={d} fill={color} />
      ))}
    </Svg>
  );
}
