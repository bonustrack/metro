import { type ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { RouteLink } from './RouteLink.js';
import { useHover } from './ui/hover.js';
import { useCardDivider, useInCard } from './SettingsSection.js';
import { hoverColor } from '../lib/theme.js';
import { SHRINK } from '../lib/style.js';

const ROW_HEIGHT = 67;
export const LIST_ICON_SIZE = 24;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: ROW_HEIGHT },
  card: { paddingHorizontal: 16, paddingVertical: 9 },
  page: { paddingVertical: 9, borderBottomWidth: 1 },
  link: { flexDirection: 'row', flexGrow: 1, flexShrink: 1, alignSelf: 'stretch', alignItems: 'center', gap: 12, minWidth: 0 },
});

interface ListRowProps {
  title: string;
  detail: string;
  href?: string;
  onPress?: () => void;
  icon?: ReactNode;
  extra?: ReactNode;
  muted?: boolean;
  trailing?: ReactNode;
  below?: ReactNode;
}

function Opener({ href, onPress, label, children }: { href?: string; onPress?: () => void; label: string; children: ReactNode }): ReactNode {
  if (href !== undefined)
    return (
      <RouteLink to={href} label={label} style={styles.link}>
        {children}
      </RouteLink>
    );
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={onPress === undefined} onPress={onPress} style={styles.link}>
      {children}
    </Pressable>
  );
}

export function ListRow({ title, detail, href, onPress, icon, extra, muted = false, trailing, below }: ListRowProps): ReactNode {
  const palette = useKitPalette();
  const inCard = useInCard();
  const divider = useCardDivider();
  const [hovered, hover] = useHover();
  const frame = inCard ? [styles.row, styles.card, divider] : [styles.row, styles.page, { borderBottomColor: palette.border }];
  const lit = hovered ? { backgroundColor: hoverColor(palette) } : null;
  return (
    <Pressable accessible={false} {...hover} style={[...frame, lit]}>
      <Opener href={href} onPress={onPress} label={title}>
        {icon}
        <Col gap={2} flex={1} minWidth={0}>
          <Row gap={8} align="center">
            <Text size="md" weight="semibold" role={muted ? 'secondary' : 'default'} numberOfLines={1} style={SHRINK}>
              {title}
            </Text>
            {extra}
          </Row>
          {detail === '' ? null : (
            <Text size="2xs" role="secondary" numberOfLines={1}>
              {detail}
            </Text>
          )}
          {below}
        </Col>
      </Opener>
      {trailing === undefined ? null : (
        <Row gap={8} align="center">
          {trailing}
        </Row>
      )}
    </Pressable>
  );
}
