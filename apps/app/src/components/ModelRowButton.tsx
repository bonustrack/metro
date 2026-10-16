import type { ReactNode } from 'react';
import { Pressable } from 'react-native';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import type { PickRow } from '@metro-labs/client/api/providers';
import { Icon } from './Icon.js';
import { useHover } from './ui/hover.js';

function niceName(row: PickRow): string {
  if (row.name === '' || row.name === row.id) return row.id;
  const cut = row.name.indexOf(': ');
  return cut === -1 ? row.name : row.name.slice(cut + 2);
}

const rowDetail = (row: PickRow): string => [niceName(row) === row.id ? '' : row.id, row.price, row.context ?? ''].filter((x) => x !== '').join(' · ');

const PICK_ROW = { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 67, paddingVertical: 9, paddingHorizontal: 16, borderRadius: 4 } as const;

export function RowButton({ row, onPick }: { row: PickRow; onPick: (row: PickRow) => void }): ReactNode {
  const palette = useKitPalette();
  const [hovered, hover] = useHover();
  const lit = row.current || hovered ? { backgroundColor: palette.inputBg } : null;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: row.current }} {...hover} style={[PICK_ROW, lit]} onPress={() => { onPick(row); }}>
      <Col gap={2} flex={1} minWidth={0}>
        <Text size="md" weight="semibold" role="link" numberOfLines={1}>
          {niceName(row)}
        </Text>
        <Text size="md" role="secondary" numberOfLines={1}>
          {rowDetail(row)}
        </Text>
      </Col>
      {row.current ? <Icon name="check" size={18} color={palette.link} /> : null}
    </Pressable>
  );
}
