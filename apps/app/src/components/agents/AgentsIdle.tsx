import { type ReactNode } from 'react';
import { activeAccount } from '@metro-labs/client/auth/account';
import { StateBlock } from '../ui/StateBlock.js';
import { PageHeader } from '../ui/PageHeader.js';
import { Wide } from '../ui/Layout.js';
import { ActivityFeed } from '../activity/ActivityFeed.js';
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
const PHONE_HINT = 'Connector calls from all your agents, as they happen.';

export function ActivityPage({ agent }: { agent?: string }): ReactNode {
  const narrow = useIsNarrow();
  useDocumentTitle('Live activity');
  return (
    <Wide gap={24}>
      <PageHeader title="Live activity" subtitle={narrow ? PHONE_HINT : WIDE_HINT} />
      <ActivityFeed key={agent ?? 'all'} agent={agent} />
    </Wide>
  );
}

export function AgentsIdle(): ReactNode {
  const { data } = useServersQuery();
  useDocumentTitle('Agents');
  if (data !== undefined && data.length === 0) return <NoAgents />;
  return <ActivityPage />;
}
