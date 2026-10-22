import { type ReactNode } from 'react';
import { routeHash } from '@metro-labs/client/route';
import { Group } from '../ui/Group.js';
import { ActivityRow } from '../activity/ActivityRow.js';
import { SectionLink } from './SectionParts.js';
import { useFreshIds, useLatestActivity } from '../../lib/activity-feed.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useNow } from '../../lib/use-now.js';

const LABEL = 'Connector activity';

export function ConnectorActivity({ agent }: { agent: string }): ReactNode {
  const calls = useLatestActivity(agent);
  const now = useNow();
  const technical = useTechnicalDetails();
  const fresh = useFreshIds(calls ?? [], calls !== null);
  if (calls === null) return null;
  if (calls.length === 0)
    return (
      <Group label={LABEL} note="No connector calls yet." wide>
        {null}
      </Group>
    );
  return (
    <Group label={LABEL} wide action={<SectionLink to={routeHash({ kind: 'activity', agent })} label="Show all" />}>
      {calls.map((call) => (
        <ActivityRow key={call.id} call={call} now={now} technical={technical} fresh={fresh.has(call.id)} showAgent={false} />
      ))}
    </Group>
  );
}
