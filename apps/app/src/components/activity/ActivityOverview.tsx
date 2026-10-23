import { type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import type { StatsConnector } from '@metro-labs/client/api/connector-stats';
import type { Server } from '@metro-labs/client/api/servers';
import { GroupTitle } from '../ui/Group.js';
import { ActivityFeed } from './ActivityFeed.js';
import { ActivityFilters } from './ActivityFilters.js';
import { CallStats } from './CallStats.js';
import { LatestCalls } from './LatestCalls.js';
import { useServersQuery } from '../../lib/queries.js';

function shownAgent(agent: string | null, known: Server[] | undefined): string | null {
  if (agent === null || known === undefined) return agent;
  return known.some((server) => server.id === agent) ? agent : null;
}

export function ActivityOverview({ agent: initial = null, full }: { agent?: string | null; full: boolean }): ReactNode {
  const known = useServersQuery().data;
  const servers = known ?? [];
  const [picked, setPicked] = useState<string | null>(initial);
  const [connector, setConnector] = useState<StatsConnector | null>(null);
  const agent = shownAgent(picked, known);
  const filter = { agent, connector: connector?.key ?? null };
  return (
    <Col gap={40} width="100%">
      <ActivityFilters servers={servers} agent={agent} onAgent={setPicked} connector={connector} onConnector={setConnector} />
      <CallStats agent={agent} picked={connector} onPick={setConnector} />
      {full ? (
        <Col>
          <GroupTitle label="All calls" />
          <ActivityFeed agent={filter.agent} connector={filter.connector} />
        </Col>
      ) : (
        <LatestCalls filter={filter} servers={servers} />
      )}
    </Col>
  );
}
