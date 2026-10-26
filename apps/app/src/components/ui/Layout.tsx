import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
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
    <Col width="100%" maxWidth={READABLE_WIDTH} gap={gap}>
      {children}
    </Col>
  );
}

export function Wide({ gap, children }: WidthProps): ReactNode {
  return (
    <Col width="100%" maxWidth={WIDE_WIDTH} gap={gap}>
      {children}
    </Col>
  );
}

export function WithRail({ rail, children }: { rail?: ReactNode; children: ReactNode }): ReactNode {
  const narrow = useIsNarrow();
  if (rail === undefined || rail === null)
    return <Col minWidth={0}>{children}</Col>;
  if (narrow)
    return (
      <Col gap={STACK_GAP}>
        <Col>{children}</Col>
        {rail}
      </Col>
    );
  return (
    <Row align="start" gap={RAIL_GAP} width="100%" maxWidth={WIDE_WIDTH}>
      <Col flex={1} minWidth={0}>
        {children}
      </Col>
      <Col width={FACTS_WIDTH}>{rail}</Col>
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
      <Text size="xs" role="secondary" numberOfLines={1}>
        {label}
      </Text>
      <Text size="md" role={valueTone} numberOfLines={2}>
        {value}
      </Text>
      {detail === undefined ? null : (
        <Text size="xs" role="secondary" numberOfLines={2}>
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
