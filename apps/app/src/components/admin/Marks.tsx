import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, type KitPalette } from '@stage-labs/kit/react-native/theme-context';
import { AgentAvatar } from '../AgentAvatar.js';
import { Icon, type IconName } from '../Icon.js';
import { markRadius, OrgPicture } from '../ui/OrgMark.js';
import { AVATAR_SIZE, ICON_SIZE } from '../ui/sizes.js';
import type { AgentState } from '../../lib/admin-agents.js';
import type { UserState } from '../../lib/admin-people.js';
import { SHRINK } from '../../lib/style.js';

const DOT = 8;

const styles = StyleSheet.create({ dot: { width: DOT, height: DOT, borderRadius: DOT / 2 } });

export type DotColor = 'success' | 'danger' | 'white' | 'grey';

function dotFill(palette: KitPalette, color: DotColor): string {
  if (color === 'success') return palette.success;
  if (color === 'danger') return palette.danger;
  return color === 'white' ? palette.link : palette.sub;
}

export function Dot({ color }: { color: DotColor }): ReactNode {
  const palette = useKitPalette();
  return <View style={StyleSheet.flatten([styles.dot, { backgroundColor: dotFill(palette, color) }])} />;
}

export const AGENT_DOT: Record<AgentState, DotColor> = { online: 'success', offline: 'danger', updating: 'grey', stopped: 'grey', checking: 'grey', unchecked: 'grey', noserver: 'grey' };

export const USER_DOT: Record<UserState, DotColor> = { approved: 'success', waitlist: 'white', rejected: 'danger', none: 'grey' };

export function DotWord({ color, word, danger = false }: { color: DotColor; word: string; danger?: boolean }): ReactNode {
  return (
    <Row align="center" gap={8} minWidth={0}>
      <Dot color={color} />
      <Text size="xs" color={danger ? 'danger' : undefined} numberOfLines={1} style={SHRINK}>
        {word}
      </Text>
    </Row>
  );
}

function LetterMark({ name, size = AVATAR_SIZE.row, round = false }: { name: string; size?: number; round?: boolean }): ReactNode {
  const palette = useKitPalette();
  return (
    <Row width={size} height={size} radius={round ? size / 2 : markRadius(size)} background={palette.border} align="center" justify="center">
      <Text size={size >= AVATAR_SIZE.list ? 'md' : '2xs'} fontWeight="semibold">
        {name.slice(0, 1).toUpperCase()}
      </Text>
    </Row>
  );
}

export function UserMark({ name, picture, size = AVATAR_SIZE.row }: { name: string; picture: string | null; size?: number }): ReactNode {
  if (picture !== null) return <AgentAvatar seed={name} src={picture} size={size} />;
  return <LetterMark name={name} size={size} round />;
}

export function OrganizationMark({ name, avatar, size = AVATAR_SIZE.row }: { name: string; avatar: string | null; size?: number }): ReactNode {
  if (avatar !== null) return <OrgPicture src={avatar} size={size} />;
  return <LetterMark name={name} size={size} />;
}

export function IconMark({ icon }: { icon: IconName }): ReactNode {
  const palette = useKitPalette();
  return (
    <Row width={AVATAR_SIZE.list} height={AVATAR_SIZE.list} align="center" justify="center">
      <Icon name={icon} size={ICON_SIZE.lg} color={palette.text} />
    </Row>
  );
}
