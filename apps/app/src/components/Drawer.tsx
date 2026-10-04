import { type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View, type GestureResponderHandlers } from 'react-native';
import { ABSOLUTE_FILL } from '../lib/style.js';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { side } from './ui/edges.js';

export const DRAWER_WIDTH = 280;

const styles = StyleSheet.create({
  fill: { flex: 1, flexDirection: 'row' },
  backdrop: { ...ABSOLUTE_FILL, backgroundColor: 'rgba(0, 0, 0, 0.4)' },
});

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  swipe: GestureResponderHandlers;
  children: ReactNode;
}

export function Drawer({ open, onClose, swipe, children }: DrawerProps): ReactNode {
  const palette = useKitPalette();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.fill} {...swipe}>
        <Pressable accessibilityLabel="Close menu" style={styles.backdrop} onPress={onClose} />
        <Col width={DRAWER_WIDTH} surface="toolbar" padding={{ top: insets.top, bottom: insets.bottom }} border={{ right: side(palette.border) }}>
          {children}
        </Col>
      </View>
    </Modal>
  );
}
