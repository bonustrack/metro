import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { PageTitle } from './PageTitle';
import { useQueryClient } from '@tanstack/react-query';
import {
  createAgent,
  type AgentSummary,
  type CreatedAgent,
} from '../api/client';
import { agentsKey, queryError, useAgentsQuery } from '../api/queries';
import { AgentRow } from './AgentRow';
import { CreateAgent } from './CreateAgent';
import { Loading } from './Loading';
import { NewAgentKey } from './NewAgentKey';
import { useDocumentTitle } from '../title';

const BLURB = 'Every agent you own on this Metro daemon.';
const FALLBACK = 'Could not load your agents.';

function AgentCards({
  agents,
  onOpen,
}: {
  agents: AgentSummary[];
  onOpen: (id: number) => void;
}): ReactNode {
  if (agents.length === 0)
    return <Text size="sm" role="secondary">No agents yet.</Text>;
  return (
    <Col>
      {agents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} onOpen={onOpen} />
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
  const client = useQueryClient();
  const { data, error } = useAgentsQuery(token);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedAgent | null>(null);
  useDocumentTitle('Agents');

  const create = async (name: string): Promise<void> => {
    const agent = await createAgent(token, name);
    setCreated(agent);
    await client.invalidateQueries({ queryKey: agentsKey() });
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

      {error === null ? null : (
        <Text size="sm" role="danger">{queryError(error, FALLBACK)}</Text>
      )}
      {data === undefined && error === null ? <Loading /> : null}
      {data === undefined ? null : (
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
