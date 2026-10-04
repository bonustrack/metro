import { type ReactNode } from 'react';
import { View } from 'react-native';

const FILL = { flexGrow: 1 } as const;

export function PageScroll({ children }: { children: ReactNode }): ReactNode {
  return <View style={FILL}>{children}</View>;
}
