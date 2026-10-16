import { type ReactNode } from 'react';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from './Icon.js';
import { Dropdown, type MenuItem } from './Dropdown.js';
import { roundFrame, roundHover } from './ui/RoundButton.js';
import { ICON_SIZE } from './ui/sizes.js';

export function KebabMenu({ items, label, ghost = false }: { items: MenuItem[]; label: string; ghost?: boolean }): ReactNode {
  const palette = useKitPalette();
  return (
    <Dropdown items={items} label={label} style={roundFrame(palette, ghost)} hoverStyle={roundHover(palette, ghost)}>
      <Icon name="dotsHorizontal" size={ICON_SIZE.md} color={ghost ? palette.sub : palette.link} />
    </Dropdown>
  );
}
