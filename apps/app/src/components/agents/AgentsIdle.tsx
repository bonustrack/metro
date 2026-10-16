import { type ReactNode } from 'react';
import { StateBlock } from '../ui/StateBlock.js';
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

export function AgentsIdle(): ReactNode {
  const { data } = useServersQuery();
  useDocumentTitle('Agents');
  if (data !== undefined && data.length === 0) return <NoAgents />;
  return <StateBlock icon="robot" title="Choose an agent" text="Pick one on the left to see what it is doing and what it needs from you." />;
}
