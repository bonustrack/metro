import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { routeHash } from '@metro-labs/client/route';
import { Icon } from '../Icon.js';
import { RouteLink } from '../RouteLink.js';
import { CountPill } from '../ui/CountPill.js';
import { SECTION_ICONS } from './section-icons.js';
import { SHELL_SECTIONS, type ShellSection, type ShellSectionId } from '../../lib/shell-sections.js';
import { useWaitingTotal } from '../../lib/agent-status.js';
import { WEB, css } from '../../lib/style.js';

const BAR = 60;
const ICON = 24;
const SIDE = 20;
export const TAB_BAR_ROOM = 128;

const styles = StyleSheet.create({
  bar: { left: SIDE, right: SIDE, height: BAR, borderRadius: BAR / 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6, zIndex: 10 },
  tab: { height: 48, minWidth: 64, paddingHorizontal: 16, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  count: { position: 'absolute', top: -12, right: -8, borderRadius: 999, borderWidth: 2 },
  icon: { position: 'relative' },
});

const PINNED = WEB ? css({ position: 'fixed' }) : css({ position: 'absolute' });

function Tab({ section, active, waiting }: { section: ShellSection; active: boolean; waiting: number }): ReactNode {
  const palette = useKitPalette();
  const frame = StyleSheet.flatten([styles.tab, active ? { backgroundColor: palette.border } : null]);
  return (
    <RouteLink to={routeHash(section.target)} label={section.label} style={frame}>
      <View style={styles.icon}>
        <Icon name={SECTION_ICONS[section.id]} size={ICON} color={active ? palette.link : palette.sub} />
        {section.id === 'agents' && waiting > 0 ? (
          <View style={StyleSheet.flatten([styles.count, { borderColor: active ? palette.border : palette.inputBg }])}>
            <CountPill count={waiting} />
          </View>
        ) : null}
      </View>
      {active ? (
        <Text size="xs" weight="semibold" numberOfLines={1}>
          {section.label}
        </Text>
      ) : null}
    </RouteLink>
  );
}

export function TabBar({ active, bottom }: { active: ShellSectionId; bottom: number }): ReactNode {
  const palette = useKitPalette();
  const waiting = useWaitingTotal();
  const place = StyleSheet.flatten([styles.bar, PINNED, { bottom, backgroundColor: palette.inputBg }]);
  return (
    <View style={place} accessibilityRole="tablist">
      {SHELL_SECTIONS.map((s) => (
        <Tab key={s.id} section={s} active={s.id === active} waiting={waiting} />
      ))}
    </View>
  );
}
