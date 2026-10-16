import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from '../Icon.js';
import { TechnicalLog } from './LaunchFrame.js';

export interface ErrorAction {
  label: string;
  note?: string;
  busy?: boolean;
  onPress: () => void;
}

interface LaunchErrorProps {
  title: string;
  reason: string;
  action: ErrorAction;
  lines: string[];
}

export function LaunchError({ title, reason, action, lines }: LaunchErrorProps): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  return (
    <>
      <Col gap={12}>
        <Icon name="exclamationCircle" size={30} color={palette.danger} />
        <Col gap={8} padding={{ top: 8 }}>
          <Text accessibilityRole="header" size="2xl" weight="semibold">{title}</Text>
          <Text size="md" role="secondary">{reason}</Text>
        </Col>
      </Col>
      <Col gap={12} align="start">
        <Row>
          <Button size="lg" color="primary" dark={dark} label={action.label} loading={action.busy} disabled={action.busy} onPress={action.onPress} />
        </Row>
        {action.note === undefined ? null : <Text size="xs" role="secondary">{action.note}</Text>}
      </Col>
      <TechnicalLog lines={lines} startOpen />
    </>
  );
}
