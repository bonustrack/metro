import { type ReactNode, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import makeBlockie from 'ethereum-blockies-base64';
import { AvatarImage } from './ui/AvatarImage.js';

const styles = StyleSheet.create({ circle: { overflow: 'hidden' } });

export function AgentAvatar({ seed, src = null, size }: { seed: string; src?: string | null; size: number }): ReactNode {
  const fallback = useMemo(() => makeBlockie(seed), [seed]);
  const circle = StyleSheet.flatten([styles.circle, { width: size, height: size, borderRadius: size / 2 }]);
  return (
    <View style={circle}>
      <AvatarImage src={src ?? fallback} size={size} />
    </View>
  );
}
