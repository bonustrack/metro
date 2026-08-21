import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { PageTitle } from './PageTitle';
import { accountsForAgent, type AccountGroup } from '../api/accounts';
import { detachAccount } from '../api/attach';
import { resetAgentKey, type AgentSummary } from '../api/client';
import { AccountList } from './AccountList';
import { AgentCredentials } from './AgentCredentials';
import { BackLink } from './BackLink';
import { ConnectStation } from './ConnectStation';
import { DeleteAgent } from './DeleteAgent';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function subtitle(agent: AgentSummary): string {
  return agent.owned ? `id ${agent.id}` : `id ${agent.id} · not owned`;
}

function emptyStations(agent: AgentSummary, unattributed: number): string {
  if (unattributed > 0)
    return `This Metro daemon returned ${plural(unattributed, 'station')} without saying which agent they belong to, so they are not shown here.`;
  return `No station is connected to “${agent.name}” yet. Connect one with the button above.`;
}

interface AgentDetailProps {
  token: string;
  agent: AgentSummary;
  groups: AccountGroup[];
  attachable: string[];
  unattributed: number;
  onOpenStation: (accountId: string) => void;
  onChanged: (dropped?: string[]) => void;
  onDelete: (id: string) => Promise<void>;
  onBack: () => void;
}

export function AgentDetail(props: AgentDetailProps): ReactNode {
  const { token, agent, groups, attachable, unattributed, onChanged } = props;
  const dark = useKitScheme() === 'dark';
  const [connecting, setConnecting] = useState(false);
  const mine = accountsForAgent(groups, agent.id);

  const onDetach = async (station: string, accountId: string): Promise<void> => {
    await detachAccount(token, agent.id, station, accountId);
    onChanged([`${station}/${accountId}`]);
  };

  const onReset = async (id: string): Promise<void> => {
    await resetAgentKey(token, id);
    onChanged();
  };

  return (
    <Col gap={20}>
      <Col gap={8}>
        <BackLink label="Agents" href="#/" onPress={props.onBack} />
        <Row justify="between" align="start" gap={12} wrap>
          <Col gap={2}>
            <PageTitle>{agent.name}</PageTitle>
            <Text size="sm" role="secondary">{subtitle(agent)}</Text>
          </Col>
          {agent.owned ? (
            <Row gap={8} align="center">
              <Button
                color="primary"
                dark={dark}
                label="Connect station"
                onPress={() => {
                  setConnecting(true);
                }}
              />
              <DeleteAgent agent={agent} onDelete={props.onDelete} />
            </Row>
          ) : null}
        </Row>
      </Col>
      <AgentCredentials agent={agent} onReset={onReset} />
      <Col gap={10}>
        <Text size="lg" weight="semibold">Stations</Text>
        <AccountList
          groups={mine}
          empty={emptyStations(agent, unattributed)}
          onOpen={props.onOpenStation}
          onDetach={agent.owned ? onDetach : undefined}
        />
      </Col>
      {agent.owned ? (
        <ConnectStation
          token={token}
          agentId={agent.id}
          attachable={attachable}
          open={connecting}
          onClose={() => {
            setConnecting(false);
          }}
          onChanged={onChanged}
        />
      ) : null}
    </Col>
  );
}
