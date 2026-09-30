import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { SHRINK } from '../theme.js';
import { opensElsewhere } from './link.js';
import { useInCard } from './SettingsSection.js';

const ROW_HEIGHT = 56;
const CARD_ROW = { x: 18 } as const;
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
    <Row align="center" gap={12} minHeight={ROW_HEIGHT} padding={inCard ? CARD_ROW : undefined} border={inCard ? undefined : { bottom: { width: 1, color: palette.border } }}>
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
        <Row gap={10} align="center" flex={1} minWidth={0}>
          <Text size="lg" weight="medium" role={muted ? 'secondary' : 'default'} numberOfLines={1} style={SHRINK}>
            {title}
          </Text>
          {extra}
          <Text size="md" role="secondary" numberOfLines={1}>
            {detail}
          </Text>
        </Row>
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
