import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { SHRINK } from '../theme.js';
import { opensElsewhere } from './link.js';
import { useInCard } from './SettingsSection.js';

const ROW_HEIGHT = 67;
const CARD_ROW = { x: 16, y: 9 } as const;
const PAGE_ROW = { y: 9 } as const;
export const LIST_ICON_SIZE = 24;

interface ListRowProps {
  title: string;
  detail: string;
  href?: string;
  onOpen: () => void;
  icon?: ReactNode;
  extra?: ReactNode;
  muted?: boolean;
  trailing?: ReactNode;
}

export function ListRow({ title, detail, href = '#', onOpen, icon, extra, muted = false, trailing }: ListRowProps): ReactNode {
  const palette = useKitPalette();
  const inCard = useInCard();
  return (
    <div className="list-row">
    <Row align="center" gap={12} minHeight={ROW_HEIGHT} padding={inCard ? CARD_ROW : PAGE_ROW} border={inCard ? undefined : { bottom: { width: 1, color: palette.border } }}>
      <a
        className="row-link"
        href={href}
        onClick={(e) => {
          if (href !== '#' && opensElsewhere(e)) return;
          e.preventDefault();
          onOpen();
        }}
      >
        {icon}
        <Col gap={2} flex={1} minWidth={0}>
          <Row gap={8} align="center">
            <Text size="2xl" weight="semibold" role={muted ? 'secondary' : 'default'} numberOfLines={1} style={SHRINK}>
              {title}
            </Text>
            {extra}
          </Row>
          {detail === '' ? null : (
            <Text size="md" role="secondary" numberOfLines={1}>
              {detail}
            </Text>
          )}
        </Col>
      </a>
      {trailing === undefined ? null : (
        <Row gap={8} align="center">
          {trailing}
        </Row>
      )}
    </Row>
    </div>
  );
}
