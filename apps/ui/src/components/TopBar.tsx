import { type ReactNode } from 'react';
import { Pressable } from 'react-native';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { MenuIcon } from './MenuIcon';

interface TopBarProps {
  onOpenMenu: () => void;
}

export function TopBar({ onOpenMenu }: TopBarProps): ReactNode {
  const palette = useKitPalette();
  return (
    <Row
      align="center"
      style={{ padding: 12 }}
    >
      <Pressable accessibilityRole="button" aria-label="Open menu" onPress={onOpenMenu}>
        <MenuIcon color={palette.text} />
      </Pressable>
    </Row>
  );
}
