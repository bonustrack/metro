import { type ReactNode } from 'react';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from './Icon.js';
import { Dropdown, type MenuItem } from './Dropdown.js';

const ICON_SIZE = { sm: 16, lg: 18 } as const;
const BOX = { sm: 32, lg: 40 } as const;

export function KebabMenu({ items, label, size = 'sm' }: { items: MenuItem[]; label: string; size?: 'sm' | 'lg' }): ReactNode {
  const palette = useKitPalette();
  const round = { width: BOX[size], height: BOX[size], borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.border } as const;
  const hover = { backgroundColor: palette.inputBg };
  return (
    <Dropdown items={items} label={label} style={round} hoverStyle={hover}>
      <Icon name="dotsHorizontal" size={ICON_SIZE[size]} color={palette.link} />
    </Dropdown>
  );
}
