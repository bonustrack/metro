import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { useTabbed } from './tabbed.js';

export function PageTitle({ children }: { children: string }): ReactNode {
  if (useTabbed()) return null;
  return (
    <Text size="5xl" weight="medium">
      {children}
    </Text>
  );
}
