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
import { RunLocally } from './RunLocally';
import { AgentConnectors } from './AgentConnectors';
import { BackLink } from './BackLink';
import { routeHash } from '../route';
import { ConnectStation } from './ConnectStation';
import { DeleteAgent } from './DeleteAgent';
import { useModeQuery } from '../api/queries';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function subtitle(agent: AgentSummary): string {
  return agent.owned ? `id ${agent.id}` : `id ${agent.id} · not owned`;
}

function RunsHere(): ReactNode {
  return (
    <Col gap={10}>
      <Text size="lg" weight="semibold">
        Runs on this machine
      </Text>
      <Text size="sm" role="secondary">
        This daemon runs the agent&apos;s stations right here, so its messages
        never pass through Metro&apos;s servers.
      </Text>
    </Col>
  );
}

function emptyStations(agent: AgentSummary, unattributed: number): string {
  if (unattributed > 0)
    return `This Metro daemon returned ${plural(unattributed, 'station')} without saying which agent they belong to, so they are not shown here.`;
  return `No station is connected to “${agent.name}” yet. Connect one with the button above.`;
}

interface AgentDetailProps {
  project: string;
  token: string;
  agent: AgentSummary;
  groups: AccountGroup[];
  attachable: string[];
  unattributed: number;
  onOpenStation: (accountId: string) => void;
  onOpenConnector: (id: string) => void;
  onChanged: (dropped?: string[]) => void;
  onDelete: (id: string) => Promise<void>;
  onBack: () => void;
}

export function AgentDetail(props: AgentDetailProps): ReactNode {
  const { token, agent, groups, attachable, unattributed, onChanged } = props;
  const dark = useKitScheme() === 'dark';
  const local = useModeQuery().data?.mode === 'local';
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
      <Col gap={12}>
        <Row justify="between" align="center" gap={12}>
          <BackLink
            label="Agents"
            href={routeHash({ kind: 'agents', project: props.project })}
            onPress={props.onBack}
          />
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
        <Col gap={8}>
          <PageTitle>{agent.name}</PageTitle>
          <Text size="sm" role="secondary">{subtitle(agent)}</Text>
        </Col>
      </Col>
      <AgentCredentials agent={agent} onReset={onReset} />
      {local ? (
        <RunsHere />
      ) : (
        <RunLocally token={token} agent={agent} onChanged={onChanged} />
      )}
      <Col gap={10}>
        <Text size="lg" weight="semibold">Stations</Text>
        <AccountList
          groups={mine}
          project={props.project}
          empty={emptyStations(agent, unattributed)}
          onOpen={props.onOpenStation}
          onDetach={agent.owned ? onDetach : undefined}
        />
      </Col>
      {local ? null : (
        <AgentConnectors
          token={token}
          project={props.project}
          agent={agent}
          onOpen={props.onOpenConnector}
        />
      )}
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
