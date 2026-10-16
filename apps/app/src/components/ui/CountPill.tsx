import { type ReactNode } from 'react';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';

export function CountPill({ count }: { count: number }): ReactNode {
  const palette = useKitPalette();
  return <Badge label={String(count)} background={palette.link} color={palette.bg} textSize="xs" />;
}
