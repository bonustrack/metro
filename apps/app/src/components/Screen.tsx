import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Root } from './Root.js';
import { useSelection } from '../lib/route-hash.js';

const styles = StyleSheet.create({ fill: { flex: 1 } });

export function Screen(): ReactNode {
  const palette = useKitPalette();
  const selection = useSelection();
  const fill = [styles.fill, { backgroundColor: palette.bg }];
  return (
    <View style={fill}>
      <Root selection={selection} />
    </View>
  );
}
