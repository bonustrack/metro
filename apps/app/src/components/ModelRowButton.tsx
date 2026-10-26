import type { ReactNode } from 'react';
import { Pressable } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
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
      <Column gap={2} weight={1} minWidth={0}>
        <Text size="md" fontWeight="semibold" color="link" numberOfLines={1}>
          {niceName(row)}
        </Text>
        <Text size="md" color="secondary" numberOfLines={1}>
          {rowDetail(row)}
        </Text>
      </Column>
      {row.current ? <Icon name="check" size={18} color={palette.link} /> : null}
    </Pressable>
  );
}
