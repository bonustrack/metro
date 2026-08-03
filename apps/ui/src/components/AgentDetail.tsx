import { type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { accountsForAgent, type AccountGroup } from '../api/accounts';
import { detachAccount, type AttachResult } from '../api/attach';
import { type AgentSummary } from '../api/client';
import { AccountList } from './AccountList';
import { AgentCredentials } from './AgentCredentials';
import { AttachAccount } from './AttachAccount';
import { AttachedAccount } from './AttachedAccount';
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
  return `No chat account is connected to “${agent.name}” yet. Connect one below.`;
}

interface AgentDetailProps {
  token: string;
  agent: AgentSummary;
  endpoint: string;
  groups: AccountGroup[];
  attachable: string[];
  unattributed: number;
  onChanged: () => void;
  onDelete: (id: number) => Promise<void>;
}

export function AgentDetail(props: AgentDetailProps): ReactNode {
  const { token, agent, groups, attachable, unattributed, onChanged } = props;
  const dark = useKitScheme() === 'dark';
  const [attached, setAttached] = useState<AttachResult | null>(null);
  const mine = accountsForAgent(groups, agent.id);

  const onDetach = async (station: string, accountId: string): Promise<void> => {
    await detachAccount(token, agent.id, station, accountId);
    if (attached?.accountId === accountId) setAttached(null);
    onChanged();
  };

  return (
    <Col gap={20}>
      <Col gap={2}>
        <Text size="2xl" weight="semibold">{agent.name}</Text>
        <Text size="2xs" role="secondary">{subtitle(agent)}</Text>
      </Col>
      <Card dark={dark} padding={14}>
        <AgentCredentials agent={agent} endpoint={props.endpoint} />
      </Card>
      <Col gap={10}>
        <Text size="lg" weight="semibold">Accounts</Text>
        <AccountList
          groups={mine}
          empty={emptyAccounts(agent, unattributed)}
          onDetach={agent.owned ? onDetach : undefined}
        />
      </Col>
      {attached !== null ? (
        <AttachedAccount
          result={attached}
          onDismiss={() => {
            setAttached(null);
          }}
        />
      ) : null}
      {agent.owned ? (
        <AttachAccount
          token={token}
          agentId={agent.id}
          attachable={attachable}
          onAttached={(result) => {
            setAttached(result);
            onChanged();
          }}
        />
      ) : null}
      {agent.owned ? (
        <DeleteAgent agent={agent} onDelete={props.onDelete} />
      ) : null}
    </Col>
  );
}
