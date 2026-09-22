import type { ReactNode } from 'react';
import { Box, Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { windowLine, type UsageWindow } from '../api/usage.js';

const BAR_HEIGHT = 4;
const BAR_RADIUS = 2;
const HIGH = 0.8;

function Bar({ used, warn }: { used: number; warn: boolean }): ReactNode {
  const palette = useKitPalette();
  return (
    <Box height={BAR_HEIGHT} radius={BAR_RADIUS} background={palette.border} width="100%">
      <Box height={BAR_HEIGHT} radius={BAR_RADIUS} background={warn ? palette.danger : palette.text} width={`${String(Math.round(used * 100))}%`} />
    </Box>
  );
}

export function UsageBars({ windows }: { windows: UsageWindow[] }): ReactNode {
  if (windows.length === 0) return null;
  return (
    <Col gap={10}>
      {windows.map((window) => (
        <Window key={window.label} window={window} />
      ))}
    </Col>
  );
}

function Window({ window }: { window: UsageWindow }): ReactNode {
  const warn = window.used !== null && window.used >= HIGH;
  return (
    <Col gap={4}>
      <Row justify="between" gap={12} wrap>
        <Text size="sm">{window.label}</Text>
        <Text size="sm" role={warn ? 'danger' : 'secondary'}>
          {windowLine(window)}
        </Text>
      </Row>
      {window.used === null ? null : <Bar used={window.used} warn={warn} />}
    </Col>
  );
}
