import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import type { DotTone } from '../../lib/tone.js';

const DOT = 13;
const RING = 3;
const OUTSET = -3;

const styles = StyleSheet.create({
  host: { position: 'relative' },
  dot: { position: 'absolute', right: OUTSET, bottom: OUTSET, width: DOT, height: DOT, borderRadius: DOT / 2, borderWidth: RING },
});

interface AvatarDotProps {
  dot?: DotTone | null;
  ring?: string;
  children: ReactNode;
}

export function AvatarDot({ dot = null, ring, children }: AvatarDotProps): ReactNode {
  const palette = useKitPalette();
  const color = dot === 'danger' ? palette.danger : palette.success;
  const mark = StyleSheet.flatten([styles.dot, { backgroundColor: color, borderColor: ring ?? palette.bg }]);
  return (
    <View style={styles.host}>
      {children}
      {dot === null ? null : <View style={mark} />}
    </View>
  );
}
