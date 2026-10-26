import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { RouteLink } from '../RouteLink.js';
import type { NowDot } from '../../lib/right-now.js';

const DOT = 8;
const DOT_BOX = 24;

const styles = StyleSheet.create({
  box: { width: DOT_BOX, alignItems: 'center', justifyContent: 'center' },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
});

export function SectionLink({ to, label }: { to: string; label: string }): ReactNode {
  return (
    <RouteLink to={to} label={label}>
      <Text size="xs">{label}</Text>
    </RouteLink>
  );
}

export function StatusDot({ tone }: { tone: NowDot }): ReactNode {
  const palette = useKitPalette();
  const color = tone === 'success' ? palette.success : tone === 'danger' ? palette.danger : tone === 'white' ? palette.link : palette.sub;
  const mark = StyleSheet.flatten([styles.dot, { backgroundColor: color }]);
  return (
    <View style={styles.box}>
      <View style={mark} />
    </View>
  );
}

export function Figure({ label, value, danger = false }: { label: string; value: string; danger?: boolean }): ReactNode {
  return (
    <Column gap={2}>
      <Text size="xs" color="secondary" numberOfLines={1}>
        {label}
      </Text>
      <Text size="lg" fontWeight="semibold" color={danger ? 'danger' : undefined} numberOfLines={1}>
        {value}
      </Text>
    </Column>
  );
}
