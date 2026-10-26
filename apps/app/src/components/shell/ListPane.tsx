import { type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { List } from '@stage-labs/kit/react-native/list';
import { Text } from '@stage-labs/kit/react-native/text';
import { webOnly } from '../../lib/style.js';

const styles = StyleSheet.create({ scroll: { flex: 1 }, content: { paddingHorizontal: 12, paddingBottom: 24 } });

const SELF_SCROLL = StyleSheet.flatten([styles.scroll, styles.content, webOnly({ overflowY: 'auto', minHeight: 0 })]);

function PaneScroll({ children }: { children: ReactNode }): ReactNode {
  if (Platform.OS === 'web') return <View style={SELF_SCROLL}>{children}</View>;
  return (
    <List style={styles.scroll} contentContainerStyle={styles.content}>
      {children}
    </List>
  );
}

export function ListPane({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <Column weight={1} minHeight={0}>
      <Row height={80} align="center" justify="spaceBetween" gap={10} padding={{ left: 24, right: 16 }}>
        <Text accessibilityRole="header" size="2xl" fontWeight="semibold" numberOfLines={1}>
          {title}
        </Text>
        {action}
      </Row>
      <PaneScroll>{children}</PaneScroll>
    </Column>
  );
}
