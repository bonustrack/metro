import { type ReactNode } from 'react';
import { activeAccount } from '@metro-labs/client/auth/account';
import { StateBlock } from '../ui/StateBlock.js';
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

export function AgentsIdle(): ReactNode {
  const { data, error } = useServersQuery();
  useDocumentTitle('Agents');
  if (data === undefined && error === null) return null;
  if (data !== undefined && data.length === 0) return <NoAgents />;
  return <StateBlock icon="robot" title="Choose an agent" text="Pick one on the left to see what it is doing and what it needs from you." />;
}
