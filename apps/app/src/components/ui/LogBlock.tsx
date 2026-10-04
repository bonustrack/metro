import { type ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type DimensionValue } from 'react-native';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';

const styles = StyleSheet.create({
  box: { borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12 },
  line: { lineHeight: 22 },
});

interface LogBlockProps {
  lines?: string[];
  text?: string;
  maxHeight?: DimensionValue | null;
  muted?: boolean;
}

export function LogBlock({ lines, text, maxHeight = 360, muted = false }: LogBlockProps): ReactNode {
  const palette = useKitPalette();
  const frame = [styles.box, { backgroundColor: palette.inputBg }, maxHeight === null ? null : { maxHeight }];
  const body = text ?? (lines ?? []).join('\n');
  const content = (
    <Text size="2xs" role={muted ? 'secondary' : 'default'} selectable style={styles.line}>
      {body}
    </Text>
  );
  return <View style={frame}>{maxHeight === null ? content : <ScrollView nestedScrollEnabled>{content}</ScrollView>}</View>;
}
