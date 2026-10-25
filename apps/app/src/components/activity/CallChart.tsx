import { type ReactNode, useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { G, Line, Path, Rect, Svg, Text as SvgText } from 'react-native-svg';
import { Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { FONT_SIZE, fontName } from '@stage-labs/kit/tokens';
import type { StatsRange } from '@metro-labs/client/api/connector-stats';
import { axisWords, bucketWords, callsWords, countWords, labelIndices, niceTicks, type StackSeries } from '../../lib/call-stats.js';
import { useIsTouch } from '../../lib/media.js';
import { hoverColor } from '../../lib/theme.js';

const PLOT = 168;
const AXIS = 26;
const HEIGHT = PLOT + AXIS;
const TOP = 8;
const BAR_MAX = 24;
const GAP = 2;
const RADIUS = 4;
const LABEL = FONT_SIZE['3xs'];
const CHAR_EM = 0.6;
const TICK_PAD = 8;
const LABEL_ROOM = 72;
const TIP_OFFSET = 12;
const KEY_WIDTH = 10;
const KEY_HEIGHT = 2;

const styles = StyleSheet.create({
  frame: { height: HEIGHT, width: '100%' },
  hit: { position: 'absolute', top: 0, height: PLOT },
  tip: { position: 'absolute', top: 0, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, gap: 4, maxWidth: 280, pointerEvents: 'none' },
  key: { width: KEY_WIDTH, height: KEY_HEIGHT, borderRadius: 1 },
});

export interface ChartUnits {
  value: (value: number) => string;
  total: (value: number) => string;
}

const CALL_UNITS: ChartUnits = { value: countWords, total: callsWords };

interface CallChartProps {
  series: StackSeries[];
  times: number[];
  bucketMs: number;
  range: StatsRange;
  summary: string;
  units?: ChartUnits;
}

interface Geometry {
  left: number;
  right: number;
  band: number;
  bar: number;
  ticks: number[];
  y: (value: number) => number;
}

interface TipRow {
  key: string;
  color: string;
  value: string;
  label: string;
}

const textWidth = (text: string): number => text.length * LABEL * CHAR_EM;

function geometryOf(width: number, totals: number[], units: ChartUnits): Geometry {
  const ticks = niceTicks(Math.max(0, ...totals));
  const top = ticks.at(-1) ?? 1;
  const left = Math.ceil(Math.max(...ticks.map((tick) => textWidth(units.value(tick))))) + TICK_PAD;
  const band = (width - left) / Math.max(1, totals.length);
  return { left, right: width, band, bar: Math.max(1, Math.min(BAR_MAX, band - GAP)), ticks, y: (value) => TOP + (PLOT - TOP) * (1 - value / top) };
}

function barPath(x: number, top: number, width: number, height: number, round: boolean): string {
  const r = round ? Math.min(RADIUS, width / 2, height) : 0;
  const bottom = top + height;
  if (r <= 0) return `M${String(x)},${String(bottom)}V${String(top)}H${String(x + width)}V${String(bottom)}Z`;
  return `M${String(x)},${String(bottom)}V${String(top + r)}A${String(r)},${String(r)} 0 0 1 ${String(x + r)},${String(top)}H${String(x + width - r)}A${String(r)},${String(r)} 0 0 1 ${String(x + width)},${String(top + r)}V${String(bottom)}Z`;
}

function Bars({ series, index, geometry }: { series: StackSeries[]; index: number; geometry: Geometry }): ReactNode {
  const painted = series.flatMap((one) => ((one.values[index] ?? 0) > 0 ? [one] : []));
  const x = geometry.left + index * geometry.band + (geometry.band - geometry.bar) / 2;
  let below = 0;
  return painted.map((one, at) => {
    const value = one.values[index] ?? 0;
    const bottom = geometry.y(below);
    below += value;
    const top = geometry.y(below);
    const lift = at > 0 && bottom - top > GAP ? GAP : 0;
    return <Path key={one.key} d={barPath(x, top, geometry.bar, Math.max(1, bottom - top - lift), at === painted.length - 1)} fill={one.color} />;
  });
}

function Axes({ geometry, times, range, units }: { geometry: Geometry; times: number[]; range: StatsRange; units: ChartUnits }): ReactNode {
  const palette = useKitPalette();
  const shown = labelIndices(range, times.length, Math.floor((geometry.right - geometry.left) / LABEL_ROOM));
  return (
    <G>
      {geometry.ticks.map((tick) => (
        <G key={tick}>
          <Line x1={geometry.left} x2={geometry.right} y1={geometry.y(tick)} y2={geometry.y(tick)} stroke={palette.border} strokeWidth={1} />
          <SvgText x={geometry.left - TICK_PAD} y={geometry.y(tick) + LABEL * 0.35} textAnchor="end" fill={palette.sub} fontSize={LABEL} fontFamily={fontName.sans}>
            {units.value(tick)}
          </SvgText>
        </G>
      ))}
      {shown.map((index) => {
        const text = axisWords(times[index] ?? 0, range);
        const half = textWidth(text) / 2;
        const centre = geometry.left + (index + 0.5) * geometry.band;
        const anchor = centre + half > geometry.right ? 'end' : centre - half < geometry.left ? 'start' : 'middle';
        const x = anchor === 'end' ? geometry.right : anchor === 'start' ? geometry.left : centre;
        return (
          <SvgText key={index} x={x} y={PLOT + LABEL + 6} textAnchor={anchor} fill={palette.sub} fontSize={LABEL} fontFamily={fontName.sans}>
            {text}
          </SvgText>
        );
      })}
    </G>
  );
}

function tipRows(series: StackSeries[], index: number, units: ChartUnits): TipRow[] {
  return [...series]
    .reverse()
    .filter((one) => one.tip && (one.values[index] ?? 0) > 0)
    .map((one) => ({ key: one.key, color: one.color, value: units.value(one.values[index] ?? 0), label: one.label }));
}

function Tip({ series, index, total, title, geometry, units }: { series: StackSeries[]; index: number; total: number; title: string; geometry: Geometry; units: ChartUnits }): ReactNode {
  const palette = useKitPalette();
  const centre = geometry.left + (index + 0.5) * geometry.band;
  const side = centre <= (geometry.left + geometry.right) / 2 ? { left: centre + TIP_OFFSET } : { right: geometry.right - centre + TIP_OFFSET };
  const frame = StyleSheet.flatten([styles.tip, { backgroundColor: palette.border }, side]);
  return (
    <View style={frame}>
      <Text size="2xs" role="secondary" numberOfLines={1}>
        {title}
      </Text>
      <Text size="xs" numberOfLines={1}>
        {units.total(total)}
      </Text>
      {tipRows(series, index, units).map((row) => (
        <Row key={row.key} gap={8} align="center">
          <View style={StyleSheet.flatten([styles.key, { backgroundColor: row.color }])} />
          <Text size="xs" numberOfLines={1}>
            {row.value}
          </Text>
          <Text size="xs" role="secondary" numberOfLines={1}>
            {row.label}
          </Text>
        </Row>
      ))}
    </View>
  );
}

function Hits({ count, geometry, words, onActive }: { count: number; geometry: Geometry; words: (index: number) => string; onActive: (update: (current: number | null) => number | null) => void }): ReactNode {
  const touch = useIsTouch();
  return Array.from({ length: count }, (_, index) => {
    const place = StyleSheet.flatten([styles.hit, { left: geometry.left + index * geometry.band, width: Math.max(1, geometry.band) }]);
    const show = (): void => { onActive(() => index); };
    const hide = (): void => { onActive((current) => (current === index ? null : current)); };
    return (
      <Pressable key={index} style={place} accessibilityRole="button" accessibilityLabel={words(index)} onHoverIn={show} onHoverOut={hide} onFocus={show} onBlur={hide}
        onPress={touch ? () => { onActive((current) => (current === index ? null : index)); } : undefined} />
    );
  });
}

export function CallChart({ series, times, bucketMs, range, summary, units = CALL_UNITS }: CallChartProps): ReactNode {
  const palette = useKitPalette();
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const totals = times.map((_, index) => series.reduce((sum, one) => sum + (one.values[index] ?? 0), 0));
  const geometry = geometryOf(width, totals, units);
  const words = (index: number): string => [`${bucketWords(times[index] ?? 0, bucketMs)}: ${units.total(totals[index] ?? 0)}`, ...tipRows(series, index, units).map((row) => `${row.label} ${row.value}`)].join(', ');
  const onLayout = (e: LayoutChangeEvent): void => {
    setWidth(Math.floor(e.nativeEvent.layout.width));
  };
  return (
    <View style={styles.frame} onLayout={onLayout} accessibilityLabel={summary}>
      {width <= 0 ? null : (
        <>
          <Svg width={width} height={HEIGHT}>
            {active === null ? null : <Rect x={geometry.left + active * geometry.band} y={TOP} width={geometry.band} height={PLOT - TOP} fill={hoverColor(palette)} />}
            <Axes geometry={geometry} times={times} range={range} units={units} />
            {times.map((at, index) => <G key={at}><Bars series={series} index={index} geometry={geometry} /></G>)}
          </Svg>
          <Hits count={times.length} geometry={geometry} words={words} onActive={setActive} />
          {active === null ? null : <Tip series={series} index={active} total={totals[active] ?? 0} title={bucketWords(times[active] ?? 0, bucketMs)} geometry={geometry} units={units} />}
        </>
      )}
    </View>
  );
}
