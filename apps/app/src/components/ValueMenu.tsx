import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Dropdown, type MenuItem } from './Dropdown.js';
import { Icon } from './Icon.js';
import { ICON_SIZE } from './ui/sizes.js';

const TRIGGER = { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 6, marginRight: -6, borderRadius: 8 } as const;

export function ValueMenu({ items, label, value }: { items: MenuItem[]; label: string; value: string }): ReactNode {
  const palette = useKitPalette();
  const hover = { backgroundColor: palette.inputBg };
  return (
    <Dropdown items={items} label={label} style={TRIGGER} hoverStyle={hover}>
      <Text size="md">{value}</Text>
      <Icon name="chevronDown" size={ICON_SIZE.sm} color={palette.sub} />
    </Dropdown>
  );
}
