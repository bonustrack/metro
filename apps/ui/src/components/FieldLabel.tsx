import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';

export function FieldLabel({ children }: { children: string }): ReactNode {
  return (
    <Text size="lg" role="secondary">
      {children}
    </Text>
  );
}
