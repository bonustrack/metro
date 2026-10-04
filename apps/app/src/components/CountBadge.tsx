import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Badge } from '@stage-labs/kit/react-native/badge';

const OPTICAL_NUDGE = 2;

export function CountBadge({ count, beside = 'heading' }: { count: number; beside?: 'title' | 'heading' }): ReactNode {
  return (
    <Row margin={{ top: beside === 'title' ? OPTICAL_NUDGE : 0 }}>
      <Badge label={String(count)} color="secondary" variant="soft" pill />
    </Row>
  );
}
