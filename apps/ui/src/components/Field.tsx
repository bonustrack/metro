import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from './ui';
import { FieldLabel } from './FieldLabel';

export function Field({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <Col gap={2} minWidth={140} maxWidth={360}>
      <FieldLabel>{label}</FieldLabel>
      <Text size="sm">{value}</Text>
    </Col>
  );
}
