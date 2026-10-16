import { useEffect, useRef, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Scroll } from '@stage-labs/kit/react-native/scroll';
import { Text } from '@stage-labs/kit/react-native/text';
import { webOnly } from '../../lib/style.js';

const styles = StyleSheet.create({ scroll: { flex: 1 }, content: { paddingHorizontal: 12, paddingBottom: 24 } });

const SELF_SCROLL = StyleSheet.flatten([styles.scroll, styles.content, webOnly({ overflowY: 'auto', minHeight: 0 })]);

const isElement = (node: unknown): node is HTMLElement => typeof HTMLElement !== 'undefined' && node instanceof HTMLElement;

function PaneScroll({ children }: { children: ReactNode }): ReactNode {
  const host = useRef<View>(null);
  useEffect(() => {
    const node: unknown = host.current;
    if (isElement(node)) node.setAttribute('data-pane-scroll', '');
  }, []);
  if (Platform.OS === 'web') return <View ref={host} style={SELF_SCROLL}>{children}</View>;
  return (
    <Scroll style={styles.scroll} contentContainerStyle={styles.content}>
      {children}
    </Scroll>
  );
}

export function ListPane({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <Col flex={1} minHeight={0}>
      <Row height={80} align="center" justify="between" gap={10} padding={{ left: 24, right: 16 }}>
        <Text accessibilityRole="header" size="2xl" weight="semibold" numberOfLines={1}>
          {title}
        </Text>
        {action}
      </Row>
      <PaneScroll>{children}</PaneScroll>
    </Col>
  );
}
