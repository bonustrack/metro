import { type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { Col } from '@stage-labs/kit/react-native/box';
import { ABSOLUTE_FILL } from '../lib/style.js';
import { BACKDROP, DRAWER_WIDTH, DrawerPanel, type DrawerProps } from './DrawerPanel.js';
import { useSwipeDrawer } from './swipe.js';

const styles = StyleSheet.create({
  fill: { flex: 1 },
  row: { flex: 1, flexDirection: 'row' },
  backdrop: { ...ABSOLUTE_FILL, backgroundColor: BACKDROP },
});

export function Drawer({ open, onOpenChange, menu, children }: DrawerProps): ReactNode {
  const swipe = useSwipeDrawer(open, onOpenChange);
  const close = (): void => {
    onOpenChange(false);
  };
  return (
    <View style={styles.fill} {...swipe}>
      {children}
      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <View style={styles.row} {...swipe}>
          <Pressable accessibilityLabel="Close menu" style={styles.backdrop} onPress={close} />
          <Col width={DRAWER_WIDTH}>
            <DrawerPanel>{menu}</DrawerPanel>
          </Col>
        </View>
      </Modal>
    </View>
  );
}
