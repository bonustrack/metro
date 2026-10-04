import { type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Scroll } from '@stage-labs/kit/react-native/scroll';

const styles = StyleSheet.create({ fill: { flex: 1 }, content: { flexGrow: 1 } });

export function PageScroll({ children }: { children: ReactNode }): ReactNode {
  return (
    <Scroll style={styles.fill} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {children}
    </Scroll>
  );
}
