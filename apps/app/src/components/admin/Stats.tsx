import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Dot, type DotColor } from './Marks.js';
import { side } from '../ui/edges.js';
import { useIsNarrow } from '../../lib/media.js';
import { SHRINK } from '../../lib/style.js';

const PHONE_PER_ROW = 3;
const WIDE_PAD = 32;
const PHONE_PAD = 20;

export interface Stat {
  label: string;
  value: number | null;
  dot?: DotColor;
}

function StatBlock({ stat, first, pad }: { stat: Stat; first: boolean; pad: number }): ReactNode {
  const palette = useKitPalette();
  return (
    <Column gap={4} padding={{ left: first ? 0 : pad, right: pad }} border={first ? undefined : { left: side(palette.border) }}>
      <Text size="2xl" fontWeight="semibold">
        {stat.value === null ? '…' : String(stat.value)}
      </Text>
      <Row align="center" gap={8}>
        {stat.dot === undefined ? null : <Dot color={stat.dot} />}
        <Text size="xs" color="secondary" numberOfLines={2} style={SHRINK}>
          {stat.label}
        </Text>
      </Row>
    </Column>
  );
}

function chunks(stats: Stat[], size: number): Stat[][] {
  return Array.from({ length: Math.ceil(stats.length / size) }, (_, at) => stats.slice(at * size, at * size + size));
}

export function Stats({ stats }: { stats: Stat[] }): ReactNode {
  const narrow = useIsNarrow();
  if (!narrow)
    return (
      <Row align="start">
        {stats.map((stat, at) => (
          <StatBlock key={stat.label} stat={stat} first={at === 0} pad={WIDE_PAD} />
        ))}
      </Row>
    );
  return (
    <Column gap={20}>
      {chunks(stats, PHONE_PER_ROW).map((line) => (
        <Row key={line.map((stat) => stat.label).join()} align="start">
          {line.map((stat, at) => (
            <Column key={stat.label} weight={1} minWidth={0}>
              <StatBlock stat={stat} first={at === 0} pad={PHONE_PAD} />
            </Column>
          ))}
          {Array.from({ length: PHONE_PER_ROW - line.length }, (_, at) => (
            <Column key={`gap-${String(at)}`} weight={1} />
          ))}
        </Row>
      ))}
    </Column>
  );
}
