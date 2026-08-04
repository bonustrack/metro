import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { type AgentSummary } from '../api/client';

interface ResetAgentKeyProps {
  agent: AgentSummary;
  onReset: (id: number) => Promise<void>;
}

const CONSEQUENCES = [
  'The current API key stops working immediately, everywhere.',
  'Any “claude mcp add” registration using it must be redone with the new command.',
  'A connected MCP session for this agent is disconnected and has to reconnect.',
  'Attachment links are not affected — each one carries its own token.',
];

export function ResetAgentKey({ agent, onReset }: ResetAgentKeyProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    onReset(agent.id).then(
      () => {
        setBusy(false);
        setConfirming(false);
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not reset the key.');
        setBusy(false);
        setConfirming(false);
      },
    );
  };

  if (!confirming)
    return (
      <Col gap={8} align="start">
        <Button
          size="sm"
          color="secondary"
          dark={dark}
          onPress={() => {
            setConfirming(true);
          }}
          label="Reset API key"
        />
        {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
      </Col>
    );

  return (
    <Col gap={8} align="start">
      <Text size="sm" weight="semibold">
        Reset the API key for “{agent.name}”?
      </Text>
      {CONSEQUENCES.map((line) => (
        <Text key={line} size="2xs" role="secondary">
          {`• ${line}`}
        </Text>
      ))}
      <Row gap={8} wrap>
        <Button
          size="sm"
          color="danger"
          dark={dark}
          onPress={reset}
          loading={busy}
          disabled={busy}
          label="Yes, reset it"
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
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}
