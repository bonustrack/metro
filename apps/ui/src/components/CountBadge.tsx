import { type ReactNode } from 'react';
import { Pill } from './Pill';

const OPTICAL_NUDGE = 4;

interface CountBadgeProps {
  count: number;
  beside?: 'title' | 'heading';
}

export function CountBadge({ count, beside = 'heading' }: CountBadgeProps): ReactNode {
  return (
    <Pill label={String(count)} nudge={beside === 'title' ? OPTICAL_NUDGE : 0} />
  );
}
