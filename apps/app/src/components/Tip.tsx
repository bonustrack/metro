import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Tooltip } from '@stage-labs/kit/react-native/tooltip';
import { useHover } from './ui/hover.js';
import { webOnly } from '../lib/style.js';

const styles = StyleSheet.create({
  host: { position: 'relative', flexDirection: 'row', alignItems: 'center' },
  tip: { position: 'absolute', bottom: '100%', marginBottom: 4, left: '50%', zIndex: 60 },
});

const CENTER = webOnly({ transform: 'translateX(-50%)', width: 'max-content', maxWidth: 320, pointerEvents: 'none' });

export function Tip({ label, children }: { label: string; children: ReactNode }): ReactNode {
  const [hovered, hover] = useHover();
  return (
    <Pressable accessible={false} accessibilityHint={label} {...hover} style={styles.host}>
      {children}
      {hovered ? (
        <View style={[styles.tip, CENTER]}>
          <Tooltip label={label} arrow="down" />
        </View>
      ) : null}
    </Pressable>
  );
}
