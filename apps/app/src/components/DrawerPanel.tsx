import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { side } from './ui/edges.js';

export const DRAWER_WIDTH = 280;

export const BACKDROP = 'rgba(0, 0, 0, 0.4)';

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  menu: ReactNode;
  children: ReactNode;
}

export function DrawerPanel({ children }: { children: ReactNode }): ReactNode {
  const palette = useKitPalette();
  const insets = useSafeAreaInsets();
  return (
    <Col flex={1} surface="toolbar" padding={{ top: insets.top, bottom: insets.bottom }} border={{ right: side(palette.border) }}>
      {children}
    </Col>
  );
}
