import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui';
import { Modal } from './Modal';

interface CreateAgentProps {
  open: boolean;
  first: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}

export function CreateAgent({ open, first, onClose, onCreate }: CreateAgentProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (): void => {
    if (busy) return;
    setName('');
    setError(null);
    onClose();
  };

  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    setError(null);
    onCreate(trimmed)
      .then(() => {
        setName('');
        onClose();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not create the agent.');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal title={first ? 'Create your first agent' : 'New agent'} open={open} onClose={close}>
      <Col gap={14}>
        <Text size="sm" role="secondary">
          Pick a name. Metro generates an API key and the registration command for Claude Code.
          Stations are attached to the agent, and show up on its page.
        </Text>
        <Input
          name="agent-name"
          value={name}
          placeholder="my-agent"
          disabled={busy}
          dark={dark}
          onChangeText={setName}
          onSubmit={submit}
          style={{ flexGrow: 1, minWidth: 0 }}
        />
        {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
        <Row justify="between" align="center" gap={12} wrap>
          <Button color="secondary" dark={dark} disabled={busy} onPress={close} label="Cancel" />
          <Button
            color="primary"
            dark={dark}
            onPress={submit}
            loading={busy}
            disabled={busy || name.trim() === ''}
            label="Create agent"
          />
        </Row>
      </Col>
    </Modal>
  );
}
