import { type ReactNode } from 'react';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Dropdown, type MenuItem } from './Dropdown';

const ICON_SIZE = { sm: 16, lg: 18 } as const;

export function KebabMenu({
  items,
  label,
  size = 'sm',
}: {
  items: MenuItem[];
  label: string;
  size?: 'sm' | 'lg';
}): ReactNode {
  const palette = useKitPalette();
  return (
    <Dropdown
      items={items}
      label={label}
      className={size === 'lg' ? 'kebab kebab-lg' : 'kebab'}
    >
      <Icon name="dotsHorizontal" size={ICON_SIZE[size]} color={palette.link} />
    </Dropdown>
  );
}
