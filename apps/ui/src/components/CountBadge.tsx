import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Badge } from '@stage-labs/kit/react-native/badge';

const OPTICAL_NUDGE = 2;

interface CountBadgeProps {
  count: number;
  beside?: 'title' | 'heading';
}

export function CountBadge({ count, beside = 'heading' }: CountBadgeProps): ReactNode {
  return (
    <Row margin={{ top: beside === 'title' ? OPTICAL_NUDGE : 0 }}>
      <Badge label={String(count)} color="secondary" variant="soft" pill />
    </Row>
  );
}
