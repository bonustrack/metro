import { type ReactNode } from 'react';
import { StateBlock } from '../ui/StateBlock.js';
import { PageHeader } from '../ui/PageHeader.js';
import { Wide } from '../ui/Layout.js';
import { ActivityFeed } from '../activity/ActivityFeed.js';
import { useIsNarrow } from '../../lib/media.js';
import { useServersQuery } from '../../lib/queries.js';
import { useDocumentTitle } from '../../lib/title.js';
import { go } from '../../lib/nav.js';

export function NoAgents(): ReactNode {
  return (
    <StateBlock
      icon="robot"
      title="No agents yet"
      text="An agent runs on its own server and answers in your chats."
      action={{ label: 'Launch an agent', primary: true, onPress: () => { go({ kind: 'launch' }); } }}
    />
  );
}

const WIDE_HINT = 'Pick an agent on the left to see what it is doing and what it needs from you.';
const PHONE_HINT = 'Connector calls from all your agents, as they happen.';

export function ActivityPage(): ReactNode {
  const narrow = useIsNarrow();
  useDocumentTitle('Live activity');
  return (
    <Wide gap={24}>
      <PageHeader title="Live activity" subtitle={narrow ? PHONE_HINT : WIDE_HINT} />
      <ActivityFeed />
    </Wide>
  );
}

export function AgentsIdle(): ReactNode {
  const { data } = useServersQuery();
  useDocumentTitle('Agents');
  if (data !== undefined && data.length === 0) return <NoAgents />;
  return <ActivityPage />;
}
