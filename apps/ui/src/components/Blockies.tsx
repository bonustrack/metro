import { type ReactElement } from 'react';
import { View } from 'react-native';
import { Rect, Svg } from 'react-native-svg';

const GRID = 8;

function makeRandom(seed: string): () => number {
  const state = [0, 0, 0, 0];
  for (let i = 0; i < seed.length; i += 1) {
    const index = i % 4;
    state[index] = ((state[index] ?? 0) << 5) - (state[index] ?? 0) + seed.charCodeAt(i);
  }
  return () => {
    const t = (state[0] ?? 0) ^ ((state[0] ?? 0) << 11);
    state[0] = state[1] ?? 0;
    state[1] = state[2] ?? 0;
    state[2] = state[3] ?? 0;
    state[3] = (state[3] ?? 0) ^ ((state[3] ?? 0) >> 19) ^ t ^ (t >> 8);
    return (state[3] >>> 0) / 2147483648;
  };
}

function makeColor(rand: () => number): string {
  const hue = Math.floor(rand() * 360);
  const saturation = rand() * 60 + 40;
  const lightness = (rand() + rand() + rand() + rand()) * 25;
  return `hsl(${String(hue)},${saturation.toFixed(0)}%,${lightness.toFixed(0)}%)`;
}

interface Blocky {
  cells: number[];
  colors: [string, string, string];
}

export function blocky(seed: string): Blocky {
  const rand = makeRandom(seed.toLowerCase());
  const colors: [string, string, string] = [
    makeColor(rand),
    makeColor(rand),
    makeColor(rand),
  ];
  const half = Math.ceil(GRID / 2);
  const cells: number[] = [];
  for (let y = 0; y < GRID; y += 1) {
    const row: number[] = [];
    for (let x = 0; x < half; x += 1) row.push(Math.floor(rand() * 2.3));
    const mirrored = row.slice(0, GRID - half).reverse();
    cells.push(...row, ...mirrored);
  }
  return { cells, colors };
}

export function Blockies({ seed, size }: { seed: string; size: number }): ReactElement {
  const { cells, colors } = blocky(seed);
  const [foreground, background, spot] = colors;
  const palette = [background, foreground, spot];

  return (
    <View style={{ width: size, height: size, borderRadius: 999, overflow: 'hidden' }}>
      <Svg width={size} height={size} viewBox={`0 0 ${String(GRID)} ${String(GRID)}`}>
        <Rect x={0} y={0} width={GRID} height={GRID} fill={background} />
        {cells.map((value, index) =>
          value === 0 ? null : (
            <Rect
              key={index}
              x={index % GRID}
              y={Math.floor(index / GRID)}
              width={1}
              height={1}
              fill={palette[value] ?? foreground}
            />
          ),
        )}
      </Svg>
    </View>
  );
}
