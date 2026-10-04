import { type ReactNode, useEffect, useRef } from 'react';
import { BackHandler, useWindowDimensions } from 'react-native';
import DrawerLayout, { DrawerKeyboardDismissMode, type DrawerLayoutMethods } from 'react-native-gesture-handler/ReanimatedDrawerLayout';
import { BACKDROP, DRAWER_WIDTH, DrawerPanel, type DrawerProps } from './DrawerPanel.js';

const SWIPE_START = 20;

export function Drawer({ open, onOpenChange, menu, children }: DrawerProps): ReactNode {
  const layout = useRef<DrawerLayoutMethods>(null);
  const shown = useRef(false);
  const { width } = useWindowDimensions();
  useEffect(() => {
    if (open === shown.current) return;
    if (open) layout.current?.openDrawer();
    else layout.current?.closeDrawer();
  }, [open]);
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
  const settled = (next: boolean): void => {
    shown.current = next;
    onOpenChange(next);
  };
  return (
    <DrawerLayout
      ref={layout}
      drawerWidth={DRAWER_WIDTH}
      edgeWidth={width}
      minSwipeDistance={SWIPE_START}
      overlayColor={BACKDROP}
      keyboardDismissMode={DrawerKeyboardDismissMode.ON_DRAG}
      onDrawerOpen={() => {
        settled(true);
      }}
      onDrawerClose={() => {
        settled(false);
      }}
      renderNavigationView={() => <DrawerPanel>{menu}</DrawerPanel>}
    >
      {children}
    </DrawerLayout>
  );
}
