import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { FACTS_WIDTH, READABLE_WIDTH, WIDE_WIDTH } from './sizes.js';
import { RouteLink } from '../RouteLink.js';
import { useIsNarrow } from '../../lib/media.js';
import type { Tone } from '../../lib/tone.js';

const RAIL_GAP = 56;
const STACK_GAP = 40;

interface WidthProps {
  gap?: number;
  children: ReactNode;
}

export function Readable({ gap, children }: WidthProps): ReactNode {
  return (
    <Column width="100%" maxWidth={READABLE_WIDTH} gap={gap}>
      {children}
    </Column>
  );
}

export function Wide({ gap, children }: WidthProps): ReactNode {
  return (
    <Column width="100%" maxWidth={WIDE_WIDTH} gap={gap}>
      {children}
    </Column>
  );
}

export function WithRail({ rail, children }: { rail?: ReactNode; children: ReactNode }): ReactNode {
  const narrow = useIsNarrow();
  if (rail === undefined || rail === null)
    return <Column minWidth={0}>{children}</Column>;
  if (narrow)
    return (
      <Column gap={STACK_GAP}>
        <Column>{children}</Column>
        {rail}
      </Column>
    );
  return (
    <Row align="start" gap={RAIL_GAP} width="100%" maxWidth={WIDE_WIDTH}>
      <Column weight={1} minWidth={0}>
        {children}
      </Column>
      <Column width={FACTS_WIDTH}>{rail}</Column>
    </Row>
  );
}

interface FactProps {
  label: string;
  value: string;
  valueTone?: Tone;
  detail?: string;
  href?: string;
  last?: boolean;
}

const factStyles = StyleSheet.create({ fact: { gap: 3, paddingVertical: 16 } });

export function Fact({ label, value, valueTone, detail, href, last = false }: FactProps): ReactNode {
  const palette = useKitPalette();
  const frame = StyleSheet.flatten([factStyles.fact, last ? null : { borderBottomWidth: 1, borderBottomColor: palette.border }]);
  const body = (
    <>
      <Text size="xs" color="secondary" numberOfLines={1}>
        {label}
      </Text>
      <Text size="md" color={valueTone} numberOfLines={2}>
        {value}
      </Text>
      {detail === undefined ? null : (
        <Text size="xs" color="secondary" numberOfLines={2}>
          {detail}
        </Text>
      )}
    </>
  );
  if (href === undefined) return <View style={frame}>{body}</View>;
  return (
    <RouteLink to={href} label={`${label}: ${value}`} style={frame}>
      {body}
    </RouteLink>
  );
}
