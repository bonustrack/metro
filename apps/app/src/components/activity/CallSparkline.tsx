import { type ReactNode } from 'react';
import { Circle, Path, Svg } from 'react-native-svg';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';

const WIDTH = 120;
const HEIGHT = 32;
const PAD = 4;
const DOT = 4;

function sparkPath(values: number[], width = WIDTH, height = HEIGHT): string {
  const top = Math.max(1, ...values);
  const step = (width - 2 * PAD) / Math.max(1, values.length - 1);
  return values.map((value, i) => `${i === 0 ? 'M' : 'L'}${(PAD + i * step).toFixed(1)},${(height - PAD - (value / top) * (height - 2 * PAD)).toFixed(1)}`).join('');
}

export function CallSparkline({ values, label }: { values: number[]; label: string }): ReactNode {
  const palette = useKitPalette();
  const top = Math.max(1, ...values);
  const last = values.at(-1) ?? 0;
  return (
    <Svg width={WIDTH} height={HEIGHT} accessibilityLabel={label}>
      <Path d={sparkPath(values)} fill="none" stroke={palette.sub} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <Circle cx={WIDTH - PAD} cy={HEIGHT - PAD - (last / top) * (HEIGHT - 2 * PAD)} r={DOT} fill={palette.link} stroke={palette.bg} strokeWidth={2} />
    </Svg>
  );
}
