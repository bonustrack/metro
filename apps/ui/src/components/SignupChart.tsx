import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import type { UserRow } from '../api/admin.js';

const DAYS = 30;
const HEIGHT = 96;
const GAP = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const SVG_STYLE = { display: 'block', width: '100%', height: HEIGHT } as const;

const dayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

export function signupsByDay(users: { createdAt: string | null }[], now: number, days = DAYS): number[] {
  const first = dayStart(now) - (days - 1) * DAY_MS;
  const counts = new Array<number>(days).fill(0);
  for (const user of users) {
    if (user.createdAt === null) continue;
    const at = Date.parse(user.createdAt);
    if (Number.isNaN(at) || at < first) continue;
    const slot = Math.min(days - 1, Math.floor((at - first) / DAY_MS));
    counts[slot] = (counts[slot] ?? 0) + 1;
  }
  return counts;
}

export function SignupChart({ users }: { users: UserRow[] }): ReactNode {
  const palette = useKitPalette();
  const now = Date.now();
  const counts = signupsByDay(users, now);
  const total = counts.reduce((a, b) => a + b, 0);
  const peak = Math.max(1, ...counts);
  const slot = 100 / DAYS;
  const from = new Date(dayStart(now) - (DAYS - 1) * DAY_MS).toLocaleDateString();
  const to = new Date(now).toLocaleDateString();
  return (
    <Col gap={6} padding={{ bottom: 8 }}>
      <Row justify="between" align="center">
        <Text size="sm" weight="semibold">
          Sign-ups, last {String(DAYS)} days
        </Text>
        <Text size="sm" role="secondary">
          {String(total)} new
        </Text>
      </Row>
      <svg viewBox={`0 0 100 ${String(HEIGHT)}`} preserveAspectRatio="none" style={SVG_STYLE} role="img" aria-label={`${String(total)} sign-ups in the last ${String(DAYS)} days`}>
        {counts.map((count, i) => {
          const h = count === 0 ? 1 : Math.max(2, (count / peak) * (HEIGHT - 4));
          return <rect key={String(i)} x={i * slot + GAP / 2} y={HEIGHT - h} width={slot - GAP} height={h} fill={count === 0 ? palette.border : palette.link} />;
        })}
      </svg>
      <Row justify="between">
        <Text size="xs" role="secondary">
          {from}
        </Text>
        <Text size="xs" role="secondary">
          {to}
        </Text>
      </Row>
    </Col>
  );
}
