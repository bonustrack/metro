import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { Rect, Svg } from 'react-native-svg';
import type { UserRow } from '@metro-labs/client/api/admin';

const DAYS = 30;
const HEIGHT = 96;
const GAP = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

const dayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

function signupsByDay(users: { createdAt: string | null }[], now: number): number[] {
  const first = dayStart(now) - (DAYS - 1) * DAY_MS;
  const counts = new Array<number>(DAYS).fill(0);
  for (const user of users) {
    if (user.createdAt === null) continue;
    const at = Date.parse(user.createdAt);
    if (Number.isNaN(at) || at < first) continue;
    const slot = Math.min(DAYS - 1, Math.floor((at - first) / DAY_MS));
    counts[slot] = (counts[slot] ?? 0) + 1;
  }
  return counts;
}

export const signupTotal = (users: { createdAt: string | null }[], now: number): number => signupsByDay(users, now).reduce((a, b) => a + b, 0);

export function SignupChart({ users, now }: { users: UserRow[]; now: number }): ReactNode {
  const palette = useKitPalette();
  const counts = signupsByDay(users, now);
  const total = counts.reduce((a, b) => a + b, 0);
  const peak = Math.max(1, ...counts);
  const slot = 100 / DAYS;
  const from = new Date(dayStart(now) - (DAYS - 1) * DAY_MS).toLocaleDateString();
  const to = new Date(now).toLocaleDateString();
  return (
    <Column gap={8} padding={{ top: 8 }}>
      <Svg width="100%" height={HEIGHT} viewBox={`0 0 100 ${String(HEIGHT)}`} preserveAspectRatio="none" accessibilityLabel={`${String(total)} sign-ups in the last ${String(DAYS)} days`}>
        {counts.map((count, i) => {
          const h = count === 0 ? 1 : Math.max(2, (count / peak) * (HEIGHT - 4));
          return <Rect key={String(i)} x={i * slot + GAP / 2} y={HEIGHT - h} width={slot - GAP} height={h} fill={count === 0 ? palette.border : palette.link} />;
        })}
      </Svg>
      <Row justify="spaceBetween">
        <Text size="2xs" color="secondary">
          {from}
        </Text>
        <Text size="2xs" color="secondary">
          {to}
        </Text>
      </Row>
    </Column>
  );
}
