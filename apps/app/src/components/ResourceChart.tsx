import { type ReactNode, useState } from 'react';
import { View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { G, Line, Path, Svg } from 'react-native-svg';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { nearest, restartLabel, segments, timeLabel, type Point, type ResourceRange, type Restart } from '@metro-labs/client/api/resources';

const WIDTH = 600;
const HEIGHT = 72;
const BOX = { width: '100%', height: HEIGHT } as const;
const RESTART_HIT = 0.02;

type Hover = Point | Restart;
const isRestart = (hover: Hover): hover is Restart => 'kind' in hover;

interface ResourceChartProps {
  title: string;
  points: Point[];
  max: number;
  range: ResourceRange;
  from: number;
  to: number;
  stepMs: number;
  restarts: Restart[];
  label: (value: number) => string;
  danger?: boolean;
}

interface Scale {
  x: (at: number) => number;
  y: (value: number) => number;
}

function scaleOf(from: number, to: number, max: number): Scale {
  return {
    x: (at) => ((at - from) / Math.max(1, to - from)) * WIDTH,
    y: (value) => HEIGHT - 1 - Math.min(1, Math.max(0, max <= 0 ? 0 : value / max)) * (HEIGHT - 2),
  };
}

function widen(segment: Point[], stepMs: number): Point[] {
  const only = segment.length === 1 ? segment[0] : undefined;
  return only === undefined ? segment : [{ at: only.at - stepMs / 2, value: only.value }, { at: only.at + stepMs / 2, value: only.value }];
}

function paths(segment: Point[], scale: Scale): { line: string; area: string } {
  const line = segment.map((p, i) => `${i === 0 ? 'M' : 'L'}${scale.x(p.at).toFixed(1)},${scale.y(p.value).toFixed(1)}`).join('');
  const first = segment[0]?.at ?? 0;
  const last = segment.at(-1)?.at ?? 0;
  return { line, area: `${line}L${scale.x(last).toFixed(1)},${String(HEIGHT)}L${scale.x(first).toFixed(1)},${String(HEIGHT)}Z` };
}

function readingOf(hover: Hover | undefined, latest: Point | undefined, label: (value: number) => string, range: ResourceRange): string {
  if (hover !== undefined) return `${isRestart(hover) ? restartLabel(hover) : label(hover.value)} at ${timeLabel(hover.at, range)}`;
  return latest === undefined ? 'No data' : label(latest.value);
}

export function ResourceChart({ title, points, max, range, from, to, stepMs, restarts, label, danger = false }: ResourceChartProps): ReactNode {
  const palette = useKitPalette();
  const [hover, setHover] = useState<Hover | undefined>(undefined);
  const scale = scaleOf(from, to, max);
  const reading = readingOf(hover, points.at(-1), label, range);
  const markColor = (restart: Restart): string => (restart.kind === 'server' ? palette.danger : palette.sub);
  const [width, setWidth] = useState(1);
  const pick = (x: number): void => {
    const at = from + (x / Math.max(1, width)) * (to - from);
    const restart = nearest(restarts, at);
    setHover(restart !== undefined && Math.abs(restart.at - at) <= RESTART_HIT * (to - from) ? restart : nearest(points, at));
  };
  const leave = (): void => {
    setHover(undefined);
  };
  const touch = (e: GestureResponderEvent): void => {
    pick(e.nativeEvent.locationX);
  };
  const pointer = {
    onPointerMove: (e: { nativeEvent: { offsetX?: number; locationX?: number } }) => {
      pick(e.nativeEvent.offsetX ?? e.nativeEvent.locationX ?? 0);
    },
    onPointerLeave: leave,
  };
  return (
    <Col gap={6}>
      <Row justify="between" align="center">
        <Text size="2xs" weight="semibold">
          {title}
        </Text>
        <Text size="2xs" role={danger && hover === undefined ? 'danger' : 'secondary'}>
          {reading}
        </Text>
      </Row>
      <View
        style={BOX}
        accessibilityRole="image"
        accessibilityLabel={`${title}: ${reading}`}
        onLayout={(e: LayoutChangeEvent) => {
          setWidth(e.nativeEvent.layout.width);
        }}
        onStartShouldSetResponder={() => true}
        onResponderGrant={touch}
        onResponderMove={touch}
        onResponderRelease={leave}
        {...pointer}
      >
        <Svg width="100%" height={HEIGHT} viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`} preserveAspectRatio="none">
          <Line x1={0} x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} stroke={palette.border} vectorEffect="non-scaling-stroke" />
          <Line x1={0} x2={WIDTH} y1={0.5} y2={0.5} stroke={palette.border} strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
          {segments(points, stepMs).map((segment) => {
            const d = paths(widen(segment, stepMs), scale);
            return (
              <G key={String(segment[0]?.at ?? 0)}>
                <Path d={d.area} fill={palette.link} fillOpacity={0.12} />
                <Path d={d.line} fill="none" stroke={palette.link} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              </G>
            );
          })}
          {restarts.map((r) => (
            <Line key={`${r.kind}${String(r.at)}`} x1={scale.x(r.at)} x2={scale.x(r.at)} y1={0} y2={HEIGHT} stroke={markColor(r)} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          ))}
          {hover === undefined ? null : (
            <Line x1={scale.x(hover.at)} x2={scale.x(hover.at)} y1={0} y2={HEIGHT} stroke={isRestart(hover) ? markColor(hover) : palette.sub} vectorEffect="non-scaling-stroke" />
          )}
        </Svg>
      </View>
      <Row justify="between">
        <Text size="3xs" role="secondary">
          {timeLabel(from, range)}
        </Text>
        <Text size="3xs" role="secondary">
          {timeLabel(to, range)}
        </Text>
      </Row>
    </Col>
  );
}
