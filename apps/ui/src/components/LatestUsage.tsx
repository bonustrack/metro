import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { useLatestUsageQuery } from '../api/queries.js';
import { latestLine } from '../api/latest-usage.js';

export function LatestUsageLine({ serverId }: { serverId: string }): ReactNode {
  const usage = useLatestUsageQuery().data?.[serverId];
  if (usage === undefined) return null;
  return (
    <Text size="2xs" role="secondary" numberOfLines={1}>
      {latestLine(usage)}
    </Text>
  );
}
