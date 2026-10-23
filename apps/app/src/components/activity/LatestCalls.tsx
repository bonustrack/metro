import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import type { Server } from '@metro-labs/client/api/servers';
import { routeHash } from '@metro-labs/client/route';
import { SectionLink } from '../home/SectionParts.js';
import { ErrorState } from '../ui/ErrorState.js';
import { Group } from '../ui/Group.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { ActivityRow } from './ActivityRow.js';
import { useFreshIds, useLatestActivity, type CallFilter } from '../../lib/activity-feed.js';
import { emptyCalls } from '../../lib/call-stats.js';
import { queryError } from '../../lib/queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useNow } from '../../lib/use-now.js';

const LABEL = 'Live activity';

export function LatestCalls({ filter, servers }: { filter: CallFilter; servers: Server[] }): ReactNode {
  const latest = useLatestActivity(filter);
  const now = useNow();
  const technical = useTechnicalDetails();
  const calls = latest.data ?? [];
  const fresh = useFreshIds(calls, latest.data !== undefined);
  const byId = new Map(servers.map((server) => [server.id, server]));
  const all = <SectionLink to={routeHash(filter.agent === null ? { kind: 'activity' } : { kind: 'activity', agent: filter.agent })} label="Show all" />;
  if (latest.data === undefined)
    return (
      <Group label={LABEL} wide>
        {latest.error === null ? <RowsSkeleton rows={5} /> : <ErrorState title="Could not read the activity" text={queryError(latest.error, 'Metro did not answer.')} onRetry={latest.refetch} />}
      </Group>
    );
  if (calls.length === 0)
    return (
      <Group label={LABEL} wide>
        <Text size="md" role="secondary">
          {emptyCalls(filter.connector)}
        </Text>
      </Group>
    );
  return (
    <Group label={LABEL} wide action={all}>
      {calls.map((call) => (
        <ActivityRow key={call.id} call={call} server={byId.get(call.agent)} now={now} technical={technical} fresh={fresh.has(call.id)} />
      ))}
    </Group>
  );
}
