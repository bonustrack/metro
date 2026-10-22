import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Icon, type IconName } from '../Icon.js';
import type { DotTone } from '../../lib/tone.js';

const DOT = 13;
const RING = 3;
const OUTSET = -3;
const BADGE = 18;
const BADGE_ICON = 10;
const BADGE_RING = 2;
const BADGE_OUTSET = -4;

const styles = StyleSheet.create({
  host: { position: 'relative' },
  dot: { position: 'absolute', right: OUTSET, bottom: OUTSET, width: DOT, height: DOT, borderRadius: DOT / 2, borderWidth: RING },
  badge: { position: 'absolute', right: BADGE_OUTSET, bottom: BADGE_OUTSET, width: BADGE, height: BADGE, borderRadius: BADGE / 2, borderWidth: BADGE_RING, alignItems: 'center', justifyContent: 'center' },
});

interface AvatarDotProps {
  dot?: DotTone | null;
  mark?: IconName;
  ring?: string;
  children: ReactNode;
}

function Badge({ mark, ring }: { mark: IconName; ring: string }): ReactNode {
  const palette = useKitPalette();
  const frame = StyleSheet.flatten([styles.badge, { backgroundColor: palette.inputBg, borderColor: ring }]);
  return (
    <View style={frame} accessible={false}>
      <Icon name={mark} size={BADGE_ICON} color={palette.text} />
    </View>
  );
}

export function AvatarDot({ dot = null, mark, ring, children }: AvatarDotProps): ReactNode {
  const palette = useKitPalette();
  const color = dot === 'danger' ? palette.danger : palette.success;
  const spot = StyleSheet.flatten([styles.dot, { backgroundColor: color, borderColor: ring ?? palette.bg }]);
  return (
    <View style={styles.host}>
      {children}
      {dot === null ? null : <View style={spot} />}
      {dot !== null || mark === undefined ? null : <Badge mark={mark} ring={ring ?? palette.bg} />}
    </View>
  );
}
