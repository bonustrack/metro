import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Icon, type IconName } from './Icon.js';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { opensElsewhere } from './link.js';
import { routeHash } from '../route.js';
import { type Selection } from './selection.js';

export const NAV_ROW_BOX = {
  align: 'center',
  gap: 14,
  minHeight: 48,
  padding: { x: 18 },
} as const;
export const NAV_ICON_SIZE = 24;

export const NAV_GAP = 0;

function NavIcon({ name, color }: { name: IconName; color: string }): ReactNode {
  return (
    <Row width={NAV_ICON_SIZE} height={NAV_ICON_SIZE} align="center" justify="center">
      <Icon name={name} size={NAV_ICON_SIZE} color={color} />
    </Row>
  );
}

interface NavRowProps {
  label: string;
  icon?: IconName;
  selected: boolean;
  target: Selection;
  onSelect: (selection: Selection) => void;
  disabled?: boolean;
}

export function NavRow({
  label,
  icon,
  selected,
  target,
  onSelect,
  disabled = false,
}: NavRowProps): ReactNode {
  const palette = useKitPalette();
  const body = (
    <Row {...NAV_ROW_BOX}>
      {icon === undefined ? null : <NavIcon name={icon} color={selected ? palette.link : palette.sub} />}
      <Text size="2xl" role={selected ? 'link' : 'secondary'} weight={selected ? 'semibold' : 'normal'} numberOfLines={1}>
        {label}
      </Text>
    </Row>
  );
  if (disabled)
    return (
      <span className="nav-link nav-row nav-link-off" aria-disabled="true" title={`${label} is unavailable while this agent is offline`}>
        {body}
      </span>
    );
  return (
    <a
      className={selected ? 'nav-link nav-row is-current' : 'nav-link nav-row'}
      href={routeHash(target)}
      onClick={(e) => {
        if (opensElsewhere(e)) return;
        e.preventDefault();
        onSelect(target);
      }}
    >
      {body}
    </a>
  );
}
