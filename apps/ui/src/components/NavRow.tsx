import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Icon, type HeroIconName } from '@stage-labs/kit/react-native/icon';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { opensElsewhere } from './link';
import { routeHash } from '../route';
import { type Selection } from './selection';

const ROW_PAD = { x: 12, y: 8 } as const;
const ICON_SIZE = 18;

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
      <Row align="center" gap={10} padding={ROW_PAD} margin={{ x: -12 }}>
        {icon === undefined ? null : (
          <Icon
            name={icon}
            size={ICON_SIZE}
            color={selected ? palette.link : palette.sub}
          />
        )}
        <Text size="xl" role={selected ? 'link' : 'secondary'} numberOfLines={1}>
          {label}
        </Text>
      </Row>
    </a>
  );
}
