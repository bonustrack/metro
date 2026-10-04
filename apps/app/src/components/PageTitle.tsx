import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { useTabbed } from './tabbed.js';

export function PageTitle({ children }: { children: string }): ReactNode {
  if (useTabbed()) return null;
  return (
    <Text accessibilityRole="header" size="2xl" weight="semibold">
      {children}
    </Text>
  );
}
