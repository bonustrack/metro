import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useLoadingVisible } from '../Loading.js';

const ROWS = ['a', 'b', 'c'];
const SHAPE = 50;
const BAR = 12;
const SHORT = 180;
const LONG = 260;

export function HomeSkeleton(): ReactNode {
  const palette = useKitPalette();
  const visible = useLoadingVisible();
  if (!visible) return null;
  return (
    <Col gap={22} accessibilityLabel="Loading">
      {ROWS.map((key) => (
        <Row key={key} gap={16} align="center">
          <Col width={SHAPE} height={SHAPE} radius={10} background={palette.inputBg} />
          <Col gap={12}>
            <Col width={SHORT} height={BAR} radius={BAR / 2} background={palette.inputBg} />
            <Col width={LONG} height={BAR} radius={BAR / 2} background={palette.inputBg} />
          </Col>
        </Row>
      ))}
    </Col>
  );
}
