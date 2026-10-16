import { type ReactNode } from 'react';
import { Pressable, type ViewStyle } from 'react-native';
import { useKitPalette, type KitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Icon, type IconName } from '../Icon.js';
import { useHover } from './hover.js';
import { ICON_SIZE, ROUND_BUTTON_SIZE } from './sizes.js';

const DIM = 0.4;

export function roundFrame(palette: KitPalette, ghost = false): ViewStyle {
  return { width: ROUND_BUTTON_SIZE, height: ROUND_BUTTON_SIZE, borderRadius: ROUND_BUTTON_SIZE / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: ghost ? 'transparent' : palette.border };
}

export const roundHover = (palette: KitPalette, ghost = false): ViewStyle => ({ backgroundColor: ghost ? palette.border : palette.inputBg });

interface RoundButtonProps {
  label: string;
  icon: IconName;
  onPress: () => void;
  disabled?: boolean;
  ghost?: boolean;
}

export function RoundButton({ label, icon, onPress, disabled = false, ghost = false }: RoundButtonProps): ReactNode {
  const palette = useKitPalette();
  const [hovered, hover] = useHover();
  const lit = hovered && !disabled;
  const frame = { ...roundFrame(palette, ghost), ...(lit ? roundHover(palette, ghost) : null), opacity: disabled ? DIM : 1 };
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} {...hover} style={frame}>
      <Icon name={icon} size={ICON_SIZE.md} color={ghost && !lit ? palette.sub : palette.link} />
    </Pressable>
  );
}
