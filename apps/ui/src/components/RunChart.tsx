import { type ReactNode, useState } from 'react';
import { Line, Path, Svg } from 'react-native-svg';
import { Box, Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import {
  barLayout,
  barPath,
  dayLabel,
  peakIndex,
  type DayBucket,
} from './runs';

const HEIGHT = 72;

type Format = (value: number) => string;

interface RunChartProps {
  title: string;
  buckets: DayBucket[];
  value: (bucket: DayBucket) => number;
  format: Format;
}

interface BarsProps {
  values: number[];
  days: string[];
  width: number;
}

function Bars({ values, days, width }: BarsProps): ReactNode {
  const palette = useKitPalette();
  const bars = barLayout(values, width, HEIGHT);
  return (
    <Svg width={width} height={HEIGHT + 1}>
      {bars.map((bar, i) => {
        const d = barPath(bar);
        return d === '' ? null : (
          <Path key={days[i] ?? String(i)} d={d} fill={palette.primary} />
        );
      })}
      <Line
        x1={0}
        y1={HEIGHT + 0.5}
        x2={width}
        y2={HEIGHT + 0.5}
        stroke={palette.border}
        strokeWidth={1}
      />
    </Svg>
  );
}

function dayOf(buckets: DayBucket[], at: number): string {
  return dayLabel(buckets[at]?.day ?? '');
}

function peakCaption(buckets: DayBucket[], values: number[], format: Format): string {
  const at = peakIndex(values);
  const top = values[at] ?? 0;
  if (top === 0) return 'nothing in this window';
  return `peak ${format(top)} on ${dayOf(buckets, at)}`;
}

function latestCaption(buckets: DayBucket[], values: number[], format: Format): string {
  const last = values.length - 1;
  return `${dayOf(buckets, last)} · ${format(values[last] ?? 0)}`;
}

export function RunChart({ title, buckets, value, format }: RunChartProps): ReactNode {
  const [width, setWidth] = useState(0);
  const values = buckets.map(value);
  return (
    <Col gap={6}>
      <Row justify="between" align="baseline" gap={8} wrap>
        <Text size="sm" weight="semibold">
          {title}
        </Text>
        <Text size="2xs" role="secondary">
          {peakCaption(buckets, values, format)}
        </Text>
      </Row>
      <Box
        style={{ width: '100%' }}
        onLayout={(e) => {
          setWidth(Math.round(e.nativeEvent.layout.width));
        }}
      >
        {width > 0 ? (
          <Bars values={values} days={buckets.map((b) => b.day)} width={width} />
        ) : null}
      </Box>
      <Row justify="between" align="center" gap={8}>
        <Text size="2xs" role="secondary">
          {dayOf(buckets, 0)}
        </Text>
        <Text size="2xs" role="secondary">
          {latestCaption(buckets, values, format)}
        </Text>
      </Row>
    </Col>
  );
}
