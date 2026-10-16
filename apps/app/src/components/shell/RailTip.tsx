import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Tooltip } from '@stage-labs/kit/react-native/tooltip';
import { useHover } from '../ui/hover.js';
import { webOnly } from '../../lib/style.js';

const styles = StyleSheet.create({
  host: { position: 'relative', alignItems: 'center', justifyContent: 'center' },
  tip: { position: 'absolute', left: '100%', top: '50%', marginLeft: 6, zIndex: 60 },
});

const BESIDE = webOnly({ transform: 'translateY(-50%)', width: 'max-content', pointerEvents: 'none' });

export function RailTip({ label, children }: { label: string; children: ReactNode }): ReactNode {
  const [hovered, hover] = useHover();
  return (
    <Pressable accessible={false} {...hover} style={styles.host}>
      {children}
      {hovered ? (
        <View style={[styles.tip, BESIDE]}>
          <Tooltip label={label} arrow="left" />
        </View>
      ) : null}
    </Pressable>
  );
}
