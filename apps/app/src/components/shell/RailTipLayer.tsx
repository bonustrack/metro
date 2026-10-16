import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '@stage-labs/kit/react-native/text';
import { Tooltip } from '@stage-labs/kit/react-native/tooltip';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useRailTip } from '../../lib/rail-tip-store.js';
import { webOnly } from '../../lib/style.js';

const LAYER = webOnly({ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000, pointerEvents: 'none' });
const BESIDE = webOnly({ position: 'absolute', transform: 'translateY(-50%)', width: 'max-content' });
const ABOVE = webOnly({ position: 'absolute', transform: 'translate(-50%, -100%)', width: 'max-content' });

export function RailTipLayer(): ReactNode {
  const tip = useRailTip();
  const palette = useKitPalette();
  if (tip === null) return null;
  const trailing = tip.shortcut === undefined ? undefined : <Text size="sm" color={palette.sub}>{tip.shortcut}</Text>;
  const where = StyleSheet.flatten([tip.side === 'top' ? ABOVE : BESIDE, { left: tip.x, top: tip.y }]);
  return (
    <View pointerEvents="none" style={LAYER}>
      <View pointerEvents="none" style={where}>
        <Tooltip label={tip.label} trailing={trailing} arrow={tip.side === 'top' ? 'down' : 'left'} />
      </View>
    </View>
  );
}
