import { type PointerEvent, type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { nearest, segments, timeLabel, type Point, type ResourceRange } from '../api/resources.js';

const WIDTH = 600;
const HEIGHT = 72;
const SVG_STYLE = { display: 'block', width: '100%', height: HEIGHT } as const;

interface ResourceChartProps {
  title: string;
  points: Point[];
  max: number;
  range: ResourceRange;
  from: number;
  to: number;
  stepMs: number;
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

export function ResourceChart({ title, points, max, range, from, to, stepMs, label, danger = false }: ResourceChartProps): ReactNode {
  const palette = useKitPalette();
  const [hover, setHover] = useState<Point | undefined>(undefined);
  const scale = scaleOf(from, to, max);
  const latest = points.at(-1);
  const shown = hover ?? latest;
  const reading = shown === undefined ? 'No data' : `${label(shown.value)}${hover === undefined ? '' : ` at ${timeLabel(hover.at, range)}`}`;
  const onMove = (e: PointerEvent<SVGSVGElement>): void => {
    const box = e.currentTarget.getBoundingClientRect();
    setHover(nearest(points, from + ((e.clientX - box.left) / Math.max(1, box.width)) * (to - from)));
  };
  return (
    <Col gap={6}>
      <Row justify="between" align="center">
        <Text size="sm" weight="semibold">
          {title}
        </Text>
        <Text size="sm" role={danger && hover === undefined ? 'danger' : 'secondary'}>
          {reading}
        </Text>
      </Row>
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
        style={SVG_STYLE}
        role="img"
        aria-label={`${title}: ${reading}`}
        onPointerMove={onMove}
        onPointerLeave={() => {
          setHover(undefined);
        }}
      >
        <line x1={0} x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} stroke={palette.border} vectorEffect="non-scaling-stroke" />
        <line x1={0} x2={WIDTH} y1={0.5} y2={0.5} stroke={palette.border} strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
        {segments(points, stepMs).map((segment) => {
          const d = paths(widen(segment, stepMs), scale);
          return (
            <g key={String(segment[0]?.at ?? 0)}>
              <path d={d.area} fill={palette.link} fillOpacity={0.12} />
              <path d={d.line} fill="none" stroke={palette.link} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
        {hover === undefined ? null : <line x1={scale.x(hover.at)} x2={scale.x(hover.at)} y1={0} y2={HEIGHT} stroke={palette.sub} vectorEffect="non-scaling-stroke" />}
      </svg>
      <Row justify="between">
        <Text size="xs" role="secondary">
          {timeLabel(from, range)}
        </Text>
        <Text size="xs" role="secondary">
          {timeLabel(to, range)}
        </Text>
      </Row>
    </Col>
  );
}
