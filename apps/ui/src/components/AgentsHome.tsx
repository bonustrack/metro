import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { PageTitle } from './PageTitle';
import { CARD_PADDING } from '../theme';
import { countAccounts, type AccountGroup } from '../api/accounts';
import { type AgentSummary } from '../api/client';

interface AgentsHomeProps {
  agents: AgentSummary[];
  groups: AccountGroup[];
  onOpen: (id: number) => void;
  onNew: () => void;
}

function summary(agent: AgentSummary, accounts: number): string {
  const label = `${String(accounts)} station${accounts === 1 ? '' : 's'}`;
  return agent.owned ? label : `${label} · granted, not owned`;
}

export function AgentsHome({ agents, groups, onOpen, onNew }: AgentsHomeProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={16}>
      <Row justify="between" align="start" gap={12} wrap>
        <Col gap={2} style={{ flexShrink: 1, minWidth: 0 }}>
          <PageTitle>Agents</PageTitle>
          <Text size="sm" role="secondary">
            Every agent you own or have been granted on this Metro daemon.
          </Text>
        </Col>
        <Button color="primary" dark={dark} label="New agent" onPress={onNew} />
      </Row>
      {agents.length === 0 ? (
        <Text size="sm" role="secondary">No agents yet.</Text>
      ) : (
        <Col gap={10}>
          {agents.map((agent) => (
            <Card
              key={agent.id}
              dark={dark}
              padding={CARD_PADDING}
              onPress={() => {
                onOpen(agent.id);
              }}
            >
              <Col gap={2}>
                <Text size="lg" weight="semibold">{agent.name}</Text>
                <Text size="sm" role="secondary">
                  {summary(agent, countAccounts(groups, agent.id))}
                </Text>
              </Col>
            </Card>
          ))}
        </Col>
      )}
    </Col>
  );
}
