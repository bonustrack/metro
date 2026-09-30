import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';

const LABEL_STYLE = {
  textTransform: 'uppercase',
  letterSpacing: 1,
} as const;

export function FieldLabel({ children }: { children: string }): ReactNode {
  return (
    <Text size="xs" role="secondary" style={LABEL_STYLE}>
      {children}
    </Text>
  );
}
