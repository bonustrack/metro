import { type ReactNode } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

const styles = StyleSheet.create({ fill: { flex: 1 }, content: { flexGrow: 1 } });

export function PageScroll({ children }: { children: ReactNode }): ReactNode {
  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}
