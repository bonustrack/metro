import { type ReactNode } from 'react';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Dropdown, type MenuItem } from './Dropdown.js';
import { Icon } from './Icon.js';

export function RowDots({ items, label }: { items: MenuItem[]; label: string }): ReactNode {
  const palette = useKitPalette();
  return <Dropdown items={items} label={label} button={{ color: 'secondary', size: 'md', icon: <Icon name="dotsHorizontal" size={18} color={palette.link} /> }} />;
}
