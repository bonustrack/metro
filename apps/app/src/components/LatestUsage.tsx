import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { latestLine } from '@metro-labs/client/api/latest-usage';
import { useLatestUsageQuery } from '../lib/queries.js';

export function LatestUsageLine({ serverId }: { serverId: string }): ReactNode {
  const usage = useLatestUsageQuery().data?.[serverId];
  if (usage === undefined) return null;
  return (
    <Text size="2xs" role="secondary" numberOfLines={1}>
      {latestLine(usage)}
    </Text>
  );
}
