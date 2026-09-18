import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { PageTitle } from './PageTitle.js';
import { CountBadge } from './CountBadge.js';

export function ListHeader({ title, count, action }: { title: string; count?: number; action?: ReactNode }): ReactNode {
  return (
    <Row justify="between" align="center" gap={12} wrap>
      <Row gap={10} align="center">
        <PageTitle>{title}</PageTitle>
        {count === undefined ? null : <CountBadge count={count} beside="title" />}
      </Row>
      {action}
    </Row>
  );
}
