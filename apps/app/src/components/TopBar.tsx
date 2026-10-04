import { type ReactNode } from 'react';
import { Pressable } from 'react-native';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MenuIcon } from './MenuIcon.js';

export function TopBar({ onOpenMenu }: { onOpenMenu: () => void }): ReactNode {
  const palette = useKitPalette();
  const insets = useSafeAreaInsets();
  return (
    <Row align="center" padding={{ x: 18, bottom: 12, top: 12 + insets.top }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Open menu" hitSlop={10} onPress={onOpenMenu}>
        <MenuIcon color={palette.text} />
      </Pressable>
    </Row>
  );
}
