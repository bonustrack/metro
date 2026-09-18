import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { SHRINK } from '../theme.js';
import { opensElsewhere } from './link.js';

const ROW_PAD_Y = 4;
export const LIST_ICON_SIZE = 20;

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
  return (
    <Row align="center" gap={12} border={{ bottom: { width: 1, color: palette.border } }}>
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
        <Row gap={10} align="center" flex={1} minWidth={0} padding={{ y: ROW_PAD_Y }}>
          <Text size="md" weight="semibold" role={muted ? 'secondary' : 'default'} numberOfLines={1} style={SHRINK}>
            {title}
          </Text>
          {extra}
          <Text size="sm" role="secondary" numberOfLines={1}>
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
  );
}
