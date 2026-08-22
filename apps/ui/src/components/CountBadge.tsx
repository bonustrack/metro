import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import {
  useKitPalette,
  useKitScheme,
} from '@stage-labs/kit/react-native/theme-context';
import { resolveBadgeStyle } from '@stage-labs/kit/badge';
import { Text } from './ui';

const PILL_RADIUS = 999;
const OPTICAL_NUDGE = 4;

interface CountBadgeProps {
  count: number;
  beside?: 'title' | 'heading';
}

export function CountBadge({ count, beside = 'heading' }: CountBadgeProps): ReactNode {
  const palette = useKitPalette();
  const { background, foreground, fontToken } = resolveBadgeStyle(
    undefined,
    palette.border,
    '3xs',
    useKitScheme(),
  );
  return (
    <Row
      background={background}
      radius={PILL_RADIUS}
      padding={{ x: 7, y: 1 }}
      margin={{ top: beside === 'title' ? OPTICAL_NUDGE : 0 }}
      align="center"
    >
      <Text size={fontToken} color={foreground}>
        {String(count)}
      </Text>
    </Row>
  );
}
