import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image } from '@stage-labs/kit/react-native/image';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';

const SQUARE_ROUNDING = 0.12;
const ROUND = 999;

export function AvatarImage({ src, size, square = false }: { src: string; size: number; square?: boolean }): ReactNode {
  const palette = useKitPalette();
  const box = StyleSheet.flatten({ width: size, height: size, borderRadius: square ? Math.round(size * SQUARE_ROUNDING) : ROUND, backgroundColor: palette.border });
  if (src.trim() === '') return <View style={box} />;
  return <Image url={src} description="" fit="cover" style={box} />;
}
