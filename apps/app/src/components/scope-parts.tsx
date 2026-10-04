import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { Icon, type IconName } from './Icon.js';
import { AgentAvatar } from './AgentAvatar.js';
import { StatusDot } from './StatusDot.js';
import { RouteLink } from './RouteLink.js';
import { useHover } from './ui/hover.js';
import { SHRINK } from '../lib/style.js';

const CHECK = 16;
const ICON = 18;

const styles = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0, minHeight: 48, paddingVertical: 9, paddingHorizontal: 16 },
  end: { marginLeft: 'auto', paddingLeft: 8 },
  face: { position: 'relative' },
  dot: { position: 'absolute', right: -3, bottom: -3, padding: 2, borderRadius: 8 },
});

export function statusWord(state: string | undefined): string {
  if (state === undefined) return 'Checking…';
  if (state === 'live') return 'Online';
  if (state === 'stopped') return 'Stopped';
  return 'Offline';
}

export function Face({ server, size }: { server: { host: string; avatar: string | null }; size: number }): ReactNode {
  const palette = useKitPalette();
  const ring = [styles.dot, { backgroundColor: palette.border }];
  return (
    <View style={styles.face}>
      <AgentAvatar seed={server.host} src={server.avatar} size={size} />
      <View style={ring}>
        <StatusDot host={server.host} />
      </View>
    </View>
  );
}

interface ScopeItemProps {
  label: string;
  current?: boolean;
  shown?: boolean;
  onHover?: () => void;
  href?: string;
  leading?: ReactNode;
  icon?: IconName;
  onSelect: () => void;
}

export function ScopeItem({ label, current = false, shown = false, onHover, href, leading, icon, onSelect }: ScopeItemProps): ReactNode {
  const palette = useKitPalette();
  const [hovered, hover] = useHover();
  const lit = { backgroundColor: palette.inputBg };
  const body = (
    <>
      {leading ?? null}
      {icon === undefined ? null : <Icon name={icon} size={ICON} color={palette.sub} />}
      <Text size="md" numberOfLines={1} style={SHRINK}>
        {label}
      </Text>
      <View style={styles.end}>{current ? <Icon name="check" size={CHECK} color={palette.link} /> : null}</View>
    </>
  );
  if (href !== undefined)
    return (
      <RouteLink
        to={href}
        label={label}
        style={[styles.item, shown ? lit : null]}
        hoverStyle={lit}
        onHoverIn={onHover}
        onPress={(event) => {
          event.preventDefault();
          onSelect();
        }}
      >
        {body}
      </RouteLink>
    );
  const enter = (): void => {
    hover.onHoverIn();
    onHover?.();
  };
  return (
    <Pressable accessibilityRole="button" onPress={onSelect} onHoverIn={enter} onHoverOut={hover.onHoverOut} style={[styles.item, shown || hovered ? lit : null]}>
      {body}
    </Pressable>
  );
}

export function ScopeColumn({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <Col flex={1} minWidth={0} padding={{ y: 8 }}>
      <Row padding={{ top: 6, x: 16, bottom: 8 }}>
        <Text size="xs" role="secondary">
          {title}
        </Text>
      </Row>
      {children}
    </Col>
  );
}
