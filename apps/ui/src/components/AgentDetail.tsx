import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { accountsForAgent, type AccountGroup } from '../api/accounts';
import { type AgentSummary } from '../api/client';
import { AccountList } from './AccountList';
import { AgentCredentials } from './AgentCredentials';
import { DeleteAgent } from './DeleteAgent';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function subtitle(agent: AgentSummary): string {
  const base = `id ${agent.id} · ${plural(agent.keys.length, 'key')}`;
  return agent.owned ? base : `${base} · granted, not owned`;
}

function emptyAccounts(agent: AgentSummary, unattributed: number): string {
  if (unattributed > 0)
    return `This Metro daemon returned ${plural(unattributed, 'account')} without saying which agent they belong to, so they are not shown here.`;
  return `No chat account is connected to “${agent.name}” yet. An operator attaches one, and it then appears here.`;
}

interface AgentDetailProps {
  agent: AgentSummary;
  endpoint: string;
  groups: AccountGroup[];
  unattributed: number;
  onDelete: (id: number) => Promise<void>;
}

export function AgentDetail({
  agent,
  endpoint,
  groups,
  unattributed,
  onDelete,
}: AgentDetailProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const mine = accountsForAgent(groups, agent.id);
  return (
    <Col gap={20}>
      <Col gap={2}>
        <Text size="2xl" weight="semibold">{agent.name}</Text>
        <Text size="2xs" role="secondary">{subtitle(agent)}</Text>
      </Col>
      <Card dark={dark} padding={14}>
        <AgentCredentials agent={agent} endpoint={endpoint} />
      </Card>
      <Col gap={10}>
        <Text size="lg" weight="semibold">Accounts</Text>
        <AccountList groups={mine} empty={emptyAccounts(agent, unattributed)} />
      </Col>
      {agent.owned ? <DeleteAgent agent={agent} onDelete={onDelete} /> : null}
    </Col>
  );
}
