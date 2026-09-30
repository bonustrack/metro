import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import {
  useKitPalette,
  useKitScheme,
} from '@stage-labs/kit/react-native/theme-context';
import { resolveBadgeStyle } from '@stage-labs/kit/badge';
import { Text } from './ui.js';
import { SMALL_FONT_SIZE, typeSize } from '../theme.js';

const PILL_RADIUS = 999;

const PILL_TEXT = { fontSize: typeSize(SMALL_FONT_SIZE['3xs']) };

interface PillProps {
  label: string;
  nudge?: number;
  variant?: 'default' | 'primary';
}

export function Pill({ label, nudge = 0, variant = 'default' }: PillProps): ReactNode {
  const palette = useKitPalette();
  const { background, foreground } = resolveBadgeStyle(
    undefined,
    variant === 'primary' ? palette.link : palette.border,
    '3xs',
    useKitScheme(),
  );
  return (
    <Row
      background={background}
      radius={PILL_RADIUS}
      padding={{ x: 7, y: 1 }}
      margin={{ top: nudge }}
      align="center"
    >
      <Text color={foreground} style={PILL_TEXT}>
        {label}
      </Text>
    </Row>
  );
}
