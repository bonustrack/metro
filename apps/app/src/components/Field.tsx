import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Text } from '@stage-labs/kit/react-native/text';
import { FieldLabel } from './FieldLabel.js';

export function Field({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <Column gap={2} minWidth={140} maxWidth={360}>
      <FieldLabel>{label}</FieldLabel>
      <Text size="md">{value}</Text>
    </Column>
  );
}
