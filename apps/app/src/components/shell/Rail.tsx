import { type ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { routeHash } from '@metro-labs/client/route';
import { activeAccount } from '@metro-labs/client/auth/account';
import { isOperator } from '@metro-labs/client/api/admin';
import { AgentAvatar } from '../AgentAvatar.js';
import { Dropdown } from '../Dropdown.js';
import { Icon, type IconName } from '../Icon.js';
import { RouteLink } from '../RouteLink.js';
import { accountItems } from '../AccountMenu.js';
import { RailOrgSwitch } from './OrgSwitch.js';
import { hideRailTip, railTip } from './RailTip.js';
import { SECTION_ICONS } from './section-icons.js';
import { SHELL_SECTIONS, type ShellSectionId } from '../../lib/shell-sections.js';
import { setTechnicalDetails, useTechnicalDetails } from '../../lib/technical.js';
import { hoverColor } from '../../lib/theme.js';
import { openJump } from '../../lib/jump-store.js';
import { useHover } from '../ui/hover.js';
import { side } from '../ui/edges.js';
import { webOnly } from '../../lib/style.js';
import { ICON_SIZE } from '../ui/sizes.js';

const RAIL_WIDTH = 72;
const ITEM = 44;
const ICON = ICON_SIZE.lg;
const ME = 32;

const styles = StyleSheet.create({
  item: { width: ITEM, height: ITEM, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});

const STICKY = webOnly({ position: 'sticky', top: 0, height: '100vh', zIndex: 5 });

function RailLink({ to, label, icon, active }: { to: string; label: string; icon: IconName; active: boolean }): ReactNode {
  const palette = useKitPalette();
  const lit = { backgroundColor: hoverColor(palette) };
  const frame = StyleSheet.flatten([styles.item, active ? lit : null]);
  return (
    <RouteLink to={to} label={label} style={frame} hoverStyle={lit} {...railTip(label)} onPress={hideRailTip}>
      <Icon name={icon} size={ICON} color={active ? palette.link : palette.sub} />
    </RouteLink>
  );
}

function RailAdmin({ active }: { active: boolean }): ReactNode {
  if (!isOperator(activeAccount())) return null;
  return <RailLink to={routeHash({ kind: 'admin' })} label="Admin" icon="shield" active={active} />;
}

const noop = (): void => undefined;

function RailJump(): ReactNode {
  const palette = useKitPalette();
  const [hovered, hover] = useHover();
  const tip = railTip('Jump', '⌘K');
  const frame = StyleSheet.flatten([styles.item, hovered ? { backgroundColor: hoverColor(palette) } : null]);
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel="Jump" onPress={() => { hideRailTip(); openJump(); }} style={frame}
      onHoverIn={(event) => { hover.onHoverIn(); tip.onHoverIn(event); }} onHoverOut={() => { hover.onHoverOut(); tip.onHoverOut(); }}>
      <Icon name="search" size={ICON} color={palette.sub} />
    </Pressable>
  );
}

function RailAccount({ onLock }: { onLock: () => void }): ReactNode {
  const account = activeAccount();
  const technical = useTechnicalDetails();
  const toggle = { label: 'Show technical details', selected: technical, onSelect: () => { setTechnicalDetails(!technical); } };
  return (
    <Dropdown label="Account menu" align="start" items={accountItems(onLock, noop, [toggle])} {...railTip(account?.user.name ?? account?.user.email ?? 'Account')}>
      <AgentAvatar seed={account?.user.id ?? 'account'} src={account?.user.picture ?? null} size={ME} />
    </Dropdown>
  );
}

export function Rail({ section, admin = false, onLock }: { section: ShellSectionId | null; admin?: boolean; onLock: () => void }): ReactNode {
  const palette = useKitPalette();
  return (
    <Column width={RAIL_WIDTH} align="center" gap={6} padding={{ y: 20 }} border={{ right: side(palette.border) }} style={STICKY}>
      <Column margin={{ bottom: 18 }}>
        <RailOrgSwitch />
      </Column>
      {SHELL_SECTIONS.map((s) => (
        <RailLink key={s.id} to={routeHash(s.target)} label={s.label} icon={SECTION_ICONS[s.id]} active={s.id === section} />
      ))}
      <Column weight={1} />
      <RailAdmin active={admin} />
      <RailJump />
      <Column margin={{ top: 10 }}>
        <RailAccount onLock={onLock} />
      </Column>
    </Column>
  );
}
