import { type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Dropdown } from '../Dropdown.js';
import { Icon } from '../Icon.js';
import { useOrganizationMenu } from '../OrganizationSwitcher.js';
import { OrgMark } from '../ui/OrgMark.js';
import { railTip } from './RailTip.js';
import { SHRINK } from '../../lib/style.js';

const RAIL_MARK = 36;
const TITLE_MARK = 28;
const CHEVRON = 18;

const styles = StyleSheet.create({
  title: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, minWidth: 0 },
});

const noop = (): void => undefined;

export function RailOrgSwitch(): ReactNode {
  const menu = useOrganizationMenu(noop);
  return (
    <>
      <Dropdown items={menu.items} label="Switch organization" align="start" {...railTip(menu.name)}>
        <OrgMark name={menu.name} src={menu.avatar} size={RAIL_MARK} />
      </Dropdown>
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
        <OrgMark name={menu.name} src={menu.avatar} size={TITLE_MARK} />
        <Text size="md" weight="semibold" numberOfLines={1} style={SHRINK}>
          {menu.name}
        </Text>
        <Icon name="chevronDown" size={CHEVRON} color={palette.sub} />
      </Dropdown>
      {menu.modal}
    </>
  );
}
