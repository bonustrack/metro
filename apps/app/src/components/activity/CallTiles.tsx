import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import type { StatTile } from '../../lib/call-stats.js';
import { useIsNarrow } from '../../lib/media.js';

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 4 },
  tile: { gap: 2, paddingVertical: 12, paddingRight: 16, borderTopWidth: 1 },
  wide: { flexGrow: 1, flexBasis: 0, minWidth: 120 },
  half: { width: '50%' },
});

function Tile({ tile, narrow }: { tile: StatTile; narrow: boolean }): ReactNode {
  const palette = useKitPalette();
  const frame = StyleSheet.flatten([styles.tile, narrow ? styles.half : styles.wide, { borderTopColor: palette.border }]);
  return (
    <View style={frame} accessible accessibilityLabel={`${tile.label}: ${tile.value}, ${tile.detail}`}>
      <Text size="xs" role="secondary" numberOfLines={1}>
        {tile.label}
      </Text>
      <Text size="2xl" weight="semibold" role={tile.danger ? 'danger' : 'default'} numberOfLines={1}>
        {tile.value}
      </Text>
      <Text size="xs" role="secondary" numberOfLines={2}>
        {tile.detail}
      </Text>
    </View>
  );
}

export function CallTiles({ tiles }: { tiles: StatTile[] }): ReactNode {
  const narrow = useIsNarrow();
  return (
    <View style={styles.grid}>
      {tiles.map((tile) => (
        <Tile key={tile.label} tile={tile} narrow={narrow} />
      ))}
    </View>
  );
}
