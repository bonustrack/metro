import { type ReactNode, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Box, Col } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { type BuildInfo } from '@metro-labs/client/build';
import { allSides } from './ui/edges.js';
import { currentBuild } from '../lib/build.js';
import { openExternal } from '../lib/open.js';
import { webOnly } from '../lib/style.js';

const DOT = 8;
const FRESH = { dark: '#ffffff', light: '#000000' } as const;

const styles = StyleSheet.create({
  dot: { position: 'absolute', right: 10, bottom: 10, alignItems: 'flex-end', zIndex: 30 },
  toggle: { padding: 6, margin: -6 },
  card: { marginBottom: 8 },
});

const FIXED = webOnly({ position: 'fixed' });

function Card({ build }: { build: BuildInfo }): ReactNode {
  const palette = useKitPalette();
  const head = build.relative === '' ? build.sha : `${build.sha} · ${build.relative}`;
  const href = build.href;
  return (
    <Pressable
      accessibilityRole="link"
      style={styles.card}
      onPress={() => {
        if (href !== null) openExternal(href);
      }}
    >
      <Col gap={2} padding={{ x: 10, y: 7 }} radius={8} surface="raised" border={allSides(palette.border)}>
        <Text size="2xs" weight="medium">
          {head}
        </Text>
        {build.time === '' ? null : (
          <Text size="2xs" role="secondary">
            {build.time}
          </Text>
        )}
      </Col>
    </Pressable>
  );
}

export function BuildDot({ bottom = 0 }: { bottom?: number }): ReactNode {
  const palette = useKitPalette();
  const fresh = useKitScheme() === 'dark' ? FRESH.dark : FRESH.light;
  const [open, setOpen] = useState(false);
  const build = currentBuild();
  const lift = { bottom: 10 + bottom };
  return (
    <View style={[styles.dot, FIXED, lift]} pointerEvents="box-none">
      {open ? <Card build={build} /> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Build ${build.sha}`}
        style={styles.toggle}
        onPress={() => {
          setOpen((v) => !v);
        }}
      >
        <Box width={DOT} height={DOT} radius={DOT} background={build.fresh ? fresh : palette.sub} />
      </Pressable>
    </View>
  );
}
