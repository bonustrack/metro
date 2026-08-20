import { type ReactNode } from 'react';
import { Text } from './ui';

export function PageTitle({ children }: { children: string }): ReactNode {
  return (
    <Text size="6xl" weight="semibold">
      {children}
    </Text>
  );
}
