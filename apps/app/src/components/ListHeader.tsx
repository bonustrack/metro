import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { PageTitle } from './PageTitle.js';
import { CountBadge } from './CountBadge.js';
import { useTabbed } from './tabbed.js';
import { side } from './ui/edges.js';

export function ListHeader({ title, count, action }: { title: string; count?: number; action?: ReactNode }): ReactNode {
  const tabbed = useTabbed();
  const palette = useKitPalette();
  if (tabbed)
    return action === undefined ? null : (
      <Row justify="end" align="center">
        {action}
      </Row>
    );
  return (
    <Row justify="between" align="center" gap={12} wrap minHeight={64} padding={{ bottom: 12 }} border={{ bottom: side(palette.border) }}>
      <Row gap={10} align="center">
        <PageTitle>{title}</PageTitle>
        {count === undefined ? null : <CountBadge count={count} beside="title" />}
      </Row>
      {action}
    </Row>
  );
}
