import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from './ui';

export function Field({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <Col gap={2} style={{ minWidth: 140, maxWidth: 360 }}>
      <Text size="2xs" role="secondary" style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </Text>
      <Text size="sm" variant="mono">{value}</Text>
    </Col>
  );
}
