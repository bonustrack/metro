import { type ReactElement } from 'react';
import { Path, Svg } from 'react-native-svg';
import { stationGlyph } from './station-icons.data';

export interface StationIconProps {
  station: string;
  size?: number;
  color: string;
}

export function StationIcon({ station, size = 20, color }: StationIconProps): ReactElement {
  const glyph = stationGlyph(station);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={glyph.d} fill={color} fillRule={glyph.evenOdd === true ? 'evenodd' : 'nonzero'} />
    </Svg>
  );
}
