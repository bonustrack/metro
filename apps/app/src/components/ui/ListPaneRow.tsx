import { type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { RouteLink } from '../RouteLink.js';
import { AvatarDot } from './AvatarDot.js';
import { hoverColor, selectedColor } from '../../lib/theme.js';
import type { DotTone, Tone } from '../../lib/tone.js';
import { SHRINK } from '../../lib/style.js';

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, minHeight: 62 },
});

export interface ListPaneRowProps {
  title: string;
  line: string;
  lineTone?: Tone;
  detail?: string;
  avatar: ReactNode;
  dot?: DotTone | null;
  trailing?: ReactNode;
  selected?: boolean;
  href: string;
}

export function ListPaneRow({ title, line, lineTone = 'secondary', detail, avatar, dot = null, trailing, selected = false, href }: ListPaneRowProps): ReactNode {
  const palette = useKitPalette();
  const fill = selected ? selectedColor(palette) : palette.bg;
  const frame = StyleSheet.flatten([styles.row, selected ? { backgroundColor: fill } : null]);
  const hover = selected ? null : { backgroundColor: hoverColor(palette) };
  return (
    <RouteLink to={href} label={title} style={frame} hoverStyle={hover}>
      <AvatarDot dot={dot} ring={fill}>
        {avatar}
      </AvatarDot>
      <Col flex={1} minWidth={0}>
        <Row align="center" justify="between" gap={10}>
          <Text size="md" numberOfLines={1} style={SHRINK}>
            {title}
          </Text>
          {trailing}
        </Row>
        <Text size="xs" role={lineTone} numberOfLines={1}>
          {line}
        </Text>
        {detail === undefined || detail === '' ? null : (
          <Text size="xs" role="secondary" numberOfLines={1}>
            {detail}
          </Text>
        )}
      </Col>
    </RouteLink>
  );
}
