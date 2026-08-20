import { type ReactElement } from 'react';
import { Path, Svg } from 'react-native-svg';

const BUBBLE =
  'M12 4c-4.42 0-8 2.91-8 6.5 0 1.95 1.06 3.7 2.73 4.89L6 20l3.86-2.06c.68.16 1.4.25 2.14.25 4.42 0 8-2.91 8-6.5S16.42 4 12 4Z';

export function ChatIcon({
  size = 16,
  color,
}: {
  size?: number;
  color: string;
}): ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d={BUBBLE}
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
    </Svg>
  );
}
