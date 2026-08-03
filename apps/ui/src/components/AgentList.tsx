import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Button } from '@stage-labs/kit/react-native/button';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { type AgentSummary } from '../api/client';
import { AgentCredentials } from './AgentCredentials';

interface AgentRowProps {
  agent: AgentSummary;
  dark: boolean;
  endpoint: string;
  onDelete: (id: number) => Promise<void>;
}

function AgentRow({ agent, dark, endpoint, onDelete }: AgentRowProps): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    onDelete(agent.id)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not delete the agent.');
        setBusy(false);
        setConfirming(false);
      });
  };

  return (
    <Card dark={dark} padding={14}>
      <Col gap={10}>
        <Row justify="between" align="center" gap={12} wrap>
          <Col gap={2}>
            <Text size="md" weight="semibold">{agent.name}</Text>
            <Text size="2xs" role="secondary">
              id {agent.id} · {agent.keys.length} key{agent.keys.length === 1 ? '' : 's'}
              {agent.owned ? '' : ' · granted, not owned'}
            </Text>
          </Col>
          {agent.owned && !confirming ? (
            <Button
              size="sm"
              color="danger"
              variant="soft"
              onPress={() => {
                setConfirming(true);
              }}
              label="Delete"
            />
          ) : null}
        </Row>
        <AgentCredentials agent={agent} endpoint={endpoint} />
        {confirming ? (
          <Col gap={8}>
            <Text size="sm" role="danger">
              Delete “{agent.name}”? Its API key stops working immediately and this cannot be
              undone.
            </Text>
            <Row gap={8} wrap>
              <Button
                size="sm"
                color="danger"
                onPress={remove}
                loading={busy}
                disabled={busy}
                label="Yes, delete it"
              />
              <Button
                size="sm"
                color="secondary"
                disabled={busy}
                onPress={() => {
                  setConfirming(false);
                }}
                label="Cancel"
              />
            </Row>
          </Col>
        ) : null}
        {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
      </Col>
    </Card>
  );
}

interface AgentListProps {
  agents: AgentSummary[];
  endpoint: string;
  onDelete: (id: number) => Promise<void>;
}

export function AgentList({ agents, endpoint, onDelete }: AgentListProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  if (agents.length === 0) return null;
  return (
    <Col gap={10}>
      <Text size="lg" weight="semibold">Agents</Text>
      <Col gap={8}>
        {agents.map((a) => (
          <AgentRow
            key={a.id}
            agent={a}
            dark={dark}
            endpoint={endpoint}
            onDelete={onDelete}
          />
        ))}
      </Col>
    </Col>
  );
}
