import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui';
import { CARD_PADDING } from '../theme';

interface CreateAgentProps {
  first: boolean;
  onCreate: (name: string) => Promise<void>;
}

export function CreateAgent({ first, onCreate }: CreateAgentProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    setError(null);
    onCreate(trimmed)
      .then(() => {
        setName('');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not create the agent.');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Card dark={dark} padding={CARD_PADDING}>
      <Col gap={12}>
        <Col gap={2}>
          <Text size="lg" weight="semibold">
            {first ? 'Create your first agent' : 'New agent'}
          </Text>
          <Text size="sm" role="secondary">
            Pick a name. Metro generates an API key and the MCP endpoint to add it to Claude Code.
            Chat accounts are attached to the agent, and show up on its page.
          </Text>
        </Col>
        <Row gap={10} align="center" wrap>
          <Input
            name="agent-name"
            value={name}
            placeholder="my-agent"
            disabled={busy}
            dark={dark}
            onChangeText={setName}
            onSubmit={submit}
            style={{ flexGrow: 1, minWidth: 180 }}
          />
          <Button
            color="primary"
            dark={dark}
            onPress={submit}
            loading={busy}
            disabled={busy || name.trim() === ''}
            label="Create agent"
          />
        </Row>
        {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
      </Col>
    </Card>
  );
}
