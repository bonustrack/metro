import { type ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Rows } from './Group.js';
import { AVATAR_SIZE } from './sizes.js';
import { side } from './edges.js';
import { shapeColor } from '../../lib/theme.js';

const TITLE = { width: 160, height: 14 } as const;
const LINE = { width: 260, height: 12 } as const;
const VALUE = { width: 60, height: 28 } as const;
const BAR_RADIUS = 7;

const styles = StyleSheet.create({
  dot: { width: AVATAR_SIZE.row, height: AVATAR_SIZE.row, borderRadius: AVATAR_SIZE.row / 2 },
  avatar: { width: AVATAR_SIZE.list, height: AVATAR_SIZE.list, borderRadius: AVATAR_SIZE.list / 2 },
  title: { ...TITLE, maxWidth: '60%', borderRadius: BAR_RADIUS },
  line: { ...LINE, maxWidth: '80%', borderRadius: BAR_RADIUS },
  value: { ...VALUE, borderRadius: VALUE.height / 2 },
});

interface RowsSkeletonProps {
  rows?: number;
  leading?: boolean;
  trailing?: boolean;
  pane?: boolean;
}

function Shape({ style, fill }: { style: ViewStyle; fill: string }): ReactNode {
  return <View style={StyleSheet.flatten([style, { backgroundColor: fill }])} />;
}

function SkeletonRow({ leading, trailing, pane, fill }: Required<Omit<RowsSkeletonProps, 'rows'>> & { fill: string }): ReactNode {
  const palette = useKitPalette();
  return (
    <Row align="center" gap={pane ? 12 : 14} minHeight={pane ? 62 : 60} padding={pane ? { x: 12, y: 10 } : { y: 14 }} border={pane ? undefined : { bottom: side(palette.border) }}>
      {leading ? <Shape style={pane ? styles.avatar : styles.dot} fill={fill} /> : null}
      <Column weight={1} minWidth={0} gap={8}>
        <Shape style={styles.title} fill={fill} />
        <Shape style={styles.line} fill={fill} />
      </Column>
      {trailing && !pane ? <Shape style={styles.value} fill={fill} /> : null}
    </Row>
  );
}

export function RowsSkeleton({ rows = 3, leading = true, trailing = true, pane = false }: RowsSkeletonProps): ReactNode {
  const fill = shapeColor(useKitPalette());
  const shapes = Array.from({ length: rows }, (_, index) => <SkeletonRow key={index} leading={leading} trailing={trailing} pane={pane} fill={fill} />);
  return (
    <View accessibilityLabel="Loading" accessibilityRole="progressbar">
      {pane ? shapes : <Rows>{shapes}</Rows>}
    </View>
  );
}
