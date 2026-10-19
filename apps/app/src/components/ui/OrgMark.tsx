import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { AvatarView } from '@stage-labs/kit/react-native/avatar-view';
import { Row } from '@stage-labs/kit/react-native/box';
import { Text, type TextSizeToken } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { AVATAR_SIZE } from './sizes.js';

const ROUNDING = 0.28;
const MEDIUM_LETTER = 36;

const styles = StyleSheet.create({ clip: { overflow: 'hidden' } });

export const markRadius = (size: number): number => Math.round(size * ROUNDING);

function letterSize(size: number): TextSizeToken {
  if (size >= AVATAR_SIZE.header) return 'xl';
  return size >= MEDIUM_LETTER ? 'md' : 'xs';
}

export function OrgPicture({ src, size }: { src: string; size: number }): ReactNode {
  const frame = StyleSheet.flatten([styles.clip, { width: size, height: size, borderRadius: markRadius(size) }]);
  return (
    <View style={frame}>
      <AvatarView src={src} size={size} square alt="" />
    </View>
  );
}

export function OrgMark({ name, src, size }: { name: string; src: string | null | undefined; size: number }): ReactNode {
  const palette = useKitPalette();
  if (typeof src === 'string') return <OrgPicture src={src} size={size} />;
  return (
    <Row width={size} height={size} radius={markRadius(size)} background={palette.link} align="center" justify="center">
      <Text size={letterSize(size)} weight="semibold" color={palette.bg}>
        {name.slice(0, 1).toUpperCase()}
      </Text>
    </Row>
  );
}
