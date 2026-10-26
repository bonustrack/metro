import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from '../Icon.js';
import { TechnicalLog } from './LaunchFrame.js';

interface ErrorAction {
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
  return (
    <>
      <Column gap={12}>
        <Icon name="exclamationCircle" size={30} color={palette.danger} />
        <Column gap={8} padding={{ top: 8 }}>
          <Text accessibilityRole="header" size="2xl" fontWeight="semibold">{title}</Text>
          <Text size="md" color="secondary">{reason}</Text>
        </Column>
      </Column>
      <Column gap={12} align="start">
        <Row>
          <Button size="lg" color="primary" label={action.label} loading={action.busy} disabled={action.busy} onPress={action.onPress} />
        </Row>
        {action.note === undefined ? null : <Text size="xs" color="secondary">{action.note}</Text>}
      </Column>
      <TechnicalLog lines={lines} startOpen />
    </>
  );
}
