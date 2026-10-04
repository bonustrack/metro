import { type ReactNode } from 'react';
import { Pressable } from 'react-native';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useHover } from './ui/hover.js';

interface RoundButtonProps {
  label: string;
  size?: number;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}

export function RoundButton({ label, size = 32, disabled = false, onPress, children }: RoundButtonProps): ReactNode {
  const palette = useKitPalette();
  const [hovered, hover] = useHover();
  const round = { width: size, height: size, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: hovered && !disabled ? palette.inputBg : palette.border, opacity: disabled ? 0.4 : 1 } as const;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} {...hover} style={round}>
      {children}
    </Pressable>
  );
}
