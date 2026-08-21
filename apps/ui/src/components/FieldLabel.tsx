import { type ReactNode } from 'react';
import { Text } from './ui';

const LABEL_STYLE = { textTransform: 'uppercase', letterSpacing: 0.4 } as const;

export function FieldLabel({ children }: { children: string }): ReactNode {
  return (
    <Text size="2xs" role="secondary" style={LABEL_STYLE}>
      {children}
    </Text>
  );
}
