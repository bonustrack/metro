import { type ReactNode, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import makeBlockie from 'ethereum-blockies-base64';
import { AvatarImage } from './ui/AvatarImage.js';

const styles = StyleSheet.create({ clip: { overflow: 'hidden' } });

export function AgentAvatar({ seed, src = null, size, square = false }: { seed: string; src?: string | null; size: number; square?: boolean }): ReactNode {
  const fallback = useMemo(() => makeBlockie(seed), [seed]);
  const image = <AvatarImage src={src ?? fallback} size={size} square={square} />;
  if (square)
    return (
      <Column width={size} height={size} radius="md" style={styles.clip}>
        {image}
      </Column>
    );
  const circle = StyleSheet.flatten([styles.clip, { width: size, height: size, borderRadius: size / 2 }]);
  return <View style={circle}>{image}</View>;
}
