import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { type AgentSummary } from '../api/client';

interface DeleteAgentProps {
  agent: AgentSummary;
  onDelete: (id: number) => Promise<void>;
}

export function DeleteAgent({ agent, onDelete }: DeleteAgentProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    onDelete(agent.id).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not delete the agent.');
      setBusy(false);
      setConfirming(false);
    });
  };

  return (
    <Col gap={8} align="start">
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
              dark={dark}
              onPress={remove}
              loading={busy}
              disabled={busy}
              label="Yes, delete it"
            />
            <Button
              size="sm"
              color="secondary"
              dark={dark}
              disabled={busy}
              onPress={() => {
                setConfirming(false);
              }}
              label="Cancel"
            />
          </Row>
        </Col>
      ) : (
        <Button
          size="sm"
          color="danger"
          variant="soft"
          dark={dark}
          onPress={() => {
            setConfirming(true);
          }}
          label="Delete agent"
        />
      )}
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}
