import { type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { routeHash } from '@metro-labs/client/route';
import { type Selection } from '@metro-labs/client/selection';
import { Icon, type IconName } from './Icon.js';
import { RouteLink } from './RouteLink.js';
import { hoverColor } from '../lib/theme.js';

export const NAV_ICON_SIZE = 24;
export const NAV_GAP = 0;

const styles = StyleSheet.create({ off: { opacity: 0.4 } });

interface NavRowProps {
  label: string;
  icon?: IconName;
  selected: boolean;
  target: Selection;
  onSelect?: () => void;
  disabled?: boolean;
}

export function NavRow({ label, icon, selected, target, onSelect, disabled = false }: NavRowProps): ReactNode {
  const palette = useKitPalette();
  const fill = selected ? { backgroundColor: palette.border } : null;
  return (
    <RouteLink to={routeHash(target)} label={label} disabled={disabled} style={[fill, disabled ? styles.off : null]} hoverStyle={selected ? null : { backgroundColor: hoverColor(palette) }} onPress={onSelect}>
      <Row align="center" gap={14} minHeight={48} padding={{ x: 18 }}>
        {icon === undefined ? null : (
          <Row width={NAV_ICON_SIZE} height={NAV_ICON_SIZE} align="center" justify="center">
            <Icon name={icon} size={NAV_ICON_SIZE} color={selected ? palette.link : palette.sub} />
          </Row>
        )}
        <Text size="md" role={selected ? 'link' : 'secondary'} weight={selected ? 'semibold' : 'normal'} numberOfLines={1}>
          {label}
        </Text>
      </Row>
    </RouteLink>
  );
}
