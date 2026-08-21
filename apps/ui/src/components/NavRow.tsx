import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Icon, type HeroIconName } from '@stage-labs/kit/react-native/icon';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { opensElsewhere } from './link';
import { routeHash } from '../route';
import { type Selection } from './selection';

export const NAV_ROW_BOX = {
  align: 'center',
  gap: 10,
  padding: { x: 12, y: 6 },
  margin: { x: -12 },
} as const;
export const NAV_ICON_SIZE = 18;

export const NAV_GAP = 6;

interface NavRowProps {
  label: string;
  icon?: HeroIconName;
  selected: boolean;
  target: Selection;
  onSelect: (selection: Selection) => void;
}

export function NavRow({
  label,
  icon,
  selected,
  target,
  onSelect,
}: NavRowProps): ReactNode {
  const palette = useKitPalette();
  return (
    <a
      className="nav-link"
      href={routeHash(target)}
      onClick={(e) => {
        if (opensElsewhere(e)) return;
        e.preventDefault();
        onSelect(target);
      }}
    >
      <Row {...NAV_ROW_BOX}>
        {icon === undefined ? null : (
          <Icon
            name={icon}
            size={NAV_ICON_SIZE}
            color={selected ? palette.link : palette.sub}
          />
        )}
        <Text size="md" role={selected ? 'link' : 'secondary'} numberOfLines={1}>
          {label}
        </Text>
      </Row>
    </a>
  );
}
