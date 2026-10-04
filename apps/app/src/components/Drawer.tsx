import { type ReactNode, useCallback, useEffect } from 'react';
import { BackHandler, StyleSheet, useWindowDimensions } from 'react-native';
import { Drawer as DrawerLayout } from 'react-native-drawer-layout';
import { type PanGesture } from 'react-native-gesture-handler';
import { BACKDROP, DRAWER_WIDTH, DrawerPanel, type DrawerProps } from './DrawerPanel.js';

const SWIPE = 20;
const SCROLL = 10;

const styles = StyleSheet.create({ drawer: { width: DRAWER_WIDTH }, overlay: { backgroundColor: BACKDROP } });

export function Drawer({ open, onOpenChange, menu, children }: DrawerProps): ReactNode {
  const { width } = useWindowDimensions();
  useEffect(() => {
    if (!open) return undefined;
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      onOpenChange(false);
      return true;
    });
    return () => {
      back.remove();
    };
  }, [open, onOpenChange]);
  const sideways = useCallback(
    (pan: PanGesture) =>
      pan
        .activeOffsetX([-SWIPE, SWIPE])
        .failOffsetX(open ? SCROLL : -SCROLL)
        .failOffsetY([-SCROLL, SCROLL]),
    [open],
  );
  return (
    <DrawerLayout
      open={open}
      onOpen={() => {
        onOpenChange(true);
      }}
      onClose={() => {
        onOpenChange(false);
      }}
      drawerStyle={styles.drawer}
      overlayStyle={styles.overlay}
      overlayAccessibilityLabel="Close menu"
      swipeEdgeWidth={width}
      configureGestureHandler={sideways}
      renderDrawerContent={() => <DrawerPanel>{menu}</DrawerPanel>}
    >
      {children}
    </DrawerLayout>
  );
}
