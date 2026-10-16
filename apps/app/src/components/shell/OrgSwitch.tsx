import { type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Dropdown } from '../Dropdown.js';
import { Icon } from '../Icon.js';
import { useOrganizationMenu } from '../OrganizationSwitcher.js';
import { RailTip } from './RailTip.js';
import { SHRINK } from '../../lib/style.js';

const RAIL_MARK = 36;
const TITLE_MARK = 28;
const CHEVRON = 18;
const ROUNDING = 0.28;

const styles = StyleSheet.create({
  title: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, minWidth: 0 },
});

function OrgMark({ name, size }: { name: string; size: number }): ReactNode {
  const palette = useKitPalette();
  return (
    <Row width={size} height={size} radius={Math.round(size * ROUNDING)} background={palette.link} align="center" justify="center">
      <Text size={size >= RAIL_MARK ? 'md' : 'xs'} weight="semibold" color={palette.bg}>
        {name.slice(0, 1).toUpperCase()}
      </Text>
    </Row>
  );
}

const noop = (): void => undefined;

export function RailOrgSwitch(): ReactNode {
  const menu = useOrganizationMenu(noop);
  return (
    <>
      <RailTip label={menu.name}>
        <Dropdown items={menu.items} label="Switch organization" align="start">
          <OrgMark name={menu.name} size={RAIL_MARK} />
        </Dropdown>
      </RailTip>
      {menu.modal}
    </>
  );
}

export function TitleOrgSwitch(): ReactNode {
  const palette = useKitPalette();
  const menu = useOrganizationMenu(noop);
  return (
    <>
      <Dropdown items={menu.items} label="Switch organization" align="start" style={styles.title}>
        <OrgMark name={menu.name} size={TITLE_MARK} />
        <Text size="md" weight="semibold" numberOfLines={1} style={SHRINK}>
          {menu.name}
        </Text>
        <Icon name="chevronDown" size={CHEVRON} color={palette.sub} />
      </Dropdown>
      {menu.modal}
    </>
  );
}
