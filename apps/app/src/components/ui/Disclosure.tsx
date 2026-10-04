import { type ReactNode, useState } from 'react';
import { Pressable } from 'react-native';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { allSides } from './edges.js';
import { LogBlock } from './LogBlock.js';

export function Disclosure({ summary, body, danger = false }: { summary: string; body: string; danger?: boolean }): ReactNode {
  const palette = useKitPalette();
  const [open, setOpen] = useState(false);
  return (
    <Col radius={8} border={allSides(palette.border)} padding={{ x: 10, y: 6 }} gap={8}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          setOpen((v) => !v);
        }}
      >
        <Text size="2xs" role={danger ? 'danger' : 'secondary'} numberOfLines={open ? undefined : 1}>
          {`${open ? '▾' : '▸'} ${summary}`}
        </Text>
      </Pressable>
      {open ? <LogBlock text={body} maxHeight={320} /> : null}
    </Col>
  );
}
