import { type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import type { IconName } from '../Icon.js';
import { RouteLink } from '../RouteLink.js';
import { AvatarDot } from './AvatarDot.js';
import { SkeletonLine } from './RowsSkeleton.js';
import { hoverColor, selectedColor } from '../../lib/theme.js';
import type { DotTone, Tone } from '../../lib/tone.js';
import { SHRINK } from '../../lib/style.js';

const LINE_PENDING = 160;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, minHeight: 62 },
});

interface ListPaneRowProps {
  title: string;
  line: string;
  lineTone?: Tone;
  linePending?: boolean;
  detail?: string;
  avatar: ReactNode;
  dot?: DotTone | null;
  mark?: IconName;
  trailing?: ReactNode;
  selected?: boolean;
  href: string;
}

function PaneLine({ text, tone, pending }: { text: string; tone: Tone; pending: boolean }): ReactNode {
  if (pending) return <SkeletonLine width={LINE_PENDING} />;
  return (
    <Text size="xs" color={tone} numberOfLines={1}>
      {text}
    </Text>
  );
}

export function ListPaneRow({ title, line, lineTone = 'secondary', linePending = false, detail, avatar, dot = null, mark, trailing, selected = false, href }: ListPaneRowProps): ReactNode {
  const palette = useKitPalette();
  const fill = selected ? selectedColor(palette) : palette.bg;
  const frame = StyleSheet.flatten([styles.row, selected ? { backgroundColor: fill } : null]);
  const hover = selected ? null : { backgroundColor: hoverColor(palette) };
  return (
    <RouteLink to={href} label={title} style={frame} hoverStyle={hover}>
      <AvatarDot dot={dot} mark={mark} ring={fill}>
        {avatar}
      </AvatarDot>
      <Column weight={1} minWidth={0}>
        <Row align="center" justify="spaceBetween" gap={10}>
          <Text size="md" numberOfLines={1} style={SHRINK}>
            {title}
          </Text>
          {trailing}
        </Row>
        <PaneLine text={line} tone={lineTone} pending={linePending} />
        {detail === undefined || detail === '' ? null : (
          <Text size="xs" color="secondary" numberOfLines={1}>
            {detail}
          </Text>
        )}
      </Column>
    </RouteLink>
  );
}
