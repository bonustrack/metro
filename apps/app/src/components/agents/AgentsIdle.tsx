import { type ReactNode } from 'react';
import { activeAccount } from '@metro-labs/client/auth/account';
import { currentOrganization } from '@metro-labs/client/auth/org-route';
import { StateBlock } from '../ui/StateBlock.js';
import { PageHeader } from '../ui/PageHeader.js';
import { Wide } from '../ui/Layout.js';
import { ActivityOverview } from '../activity/ActivityOverview.js';
import { useIsNarrow } from '../../lib/media.js';
import { useServersQuery } from '../../lib/queries.js';
import { useDocumentTitle } from '../../lib/title.js';
import { go } from '../../lib/nav.js';
import { ADD_AGENT_ADMIN, mayAddAgent } from '../../lib/launch-steps.js';

export function NoAgents(): ReactNode {
  const admin = mayAddAgent(activeAccount()?.role);
  return (
    <StateBlock
      icon="robot"
      title="No agents yet"
      text={admin ? 'An agent answers in your chats from its own server, or brings your connectors to Claude Code.' : ADD_AGENT_ADMIN}
      action={admin ? { label: 'New agent', primary: true, onPress: () => { go({ kind: 'launch' }); } } : undefined}
    />
  );
}

const WIDE_HINT = 'Pick an agent on the left to see what it is doing and what it needs from you.';
const FEED_HINT = 'Connector calls from all your agents, as they happen.';

const overviewKey = (agent: string | undefined): string => `${currentOrganization() ?? 'none'}:${agent ?? 'all'}`;

export function ActivityPage({ agent }: { agent?: string }): ReactNode {
  useDocumentTitle('Live activity');
  return (
    <Wide gap={24}>
      <PageHeader title="Live activity" subtitle={FEED_HINT} />
      <ActivityOverview key={overviewKey(agent)} agent={agent ?? null} full />
    </Wide>
  );
}

export function AgentsIdle(): ReactNode {
  const { data } = useServersQuery();
  const narrow = useIsNarrow();
  useDocumentTitle('Agents');
  if (data !== undefined && data.length === 0) return <NoAgents />;
  return (
    <Wide gap={24}>
      <PageHeader title="Activity" subtitle={narrow ? FEED_HINT : WIDE_HINT} />
      <ActivityOverview key={overviewKey(undefined)} full={false} />
    </Wide>
  );
}
