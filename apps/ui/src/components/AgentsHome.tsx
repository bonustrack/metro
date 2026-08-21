import { type ReactNode, useCallback, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { PageTitle } from './PageTitle';
import { CARD_PADDING } from '../theme';
import {
  createAgent,
  fetchAgents,
  type AgentSummary,
  type CreatedAgent,
} from '../api/client';
import { useLoad } from '../load';
import { CreateAgent } from './CreateAgent';
import { Loading } from './Loading';
import { NewAgentKey } from './NewAgentKey';
import { useDocumentTitle } from '../title';

const BLURB = 'Every agent you own on this Metro daemon.';
const FALLBACK = 'Could not load your agents.';

function subtitle(agent: AgentSummary): string {
  return agent.owned ? `id ${agent.id}` : `id ${agent.id} · not owned`;
}

function AgentCards({
  agents,
  onOpen,
}: {
  agents: AgentSummary[];
  onOpen: (id: number) => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  if (agents.length === 0)
    return <Text size="sm" role="secondary">No agents yet.</Text>;
  return (
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
            <Text size="sm" role="secondary">{subtitle(agent)}</Text>
          </Col>
        </Card>
      ))}
    </Col>
  );
}

interface AgentsHomeProps {
  token: string;
  onOpen: (id: number) => void;
}

export function AgentsHome({ token, onOpen }: AgentsHomeProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const load = useCallback(() => fetchAgents(token), [token]);
  const { data, error, reload } = useLoad(load, FALLBACK);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedAgent | null>(null);
  useDocumentTitle('Agents');

  const create = async (name: string): Promise<void> => {
    const agent = await createAgent(token, name);
    setCreated(agent);
    reload();
  };

  return (
    <Col gap={16}>
      <Row justify="between" align="start" gap={12} wrap>
        <Col gap={2} style={{ flexShrink: 1, minWidth: 0 }}>
          <PageTitle>Agents</PageTitle>
          <Text size="sm" role="secondary">{BLURB}</Text>
        </Col>
        <Button
          color="primary"
          dark={dark}
          label="New agent"
          onPress={() => {
            setCreating(true);
          }}
        />
      </Row>

      {created === null ? null : (
        <NewAgentKey
          created={created}
          onDismiss={() => {
            setCreated(null);
          }}
        />
      )}

      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
      {data === null && error === null ? <Loading /> : null}
      {data === null ? null : (
        <AgentCards agents={data.agents} onOpen={onOpen} />
      )}

      <CreateAgent
        open={creating}
        first={data?.agents.length === 0}
        onClose={() => {
          setCreating(false);
        }}
        onCreate={create}
      />
    </Col>
  );
}
