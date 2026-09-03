import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui';
import { GROW } from '../theme';
import { Modal } from './Modal';

const HOW =
  'On metro.box, open the agent’s page and click Run locally to get a pairing code, then paste it here. The agent moves to this machine with its stations and their credentials, keeps its id and key, and runs here from now on. If metro start runs it on this machine, stop that first (metro stop).';

interface ImportAgentProps {
  open: boolean;
  onClose: () => void;
  onImport: (code: string) => Promise<void>;
}

export function ImportAgent({ open, onClose, onImport }: ImportAgentProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (): void => {
    if (busy) return;
    setCode('');
    setError(null);
    onClose();
  };

  const submit = (): void => {
    const trimmed = code.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    setError(null);
    onImport(trimmed)
      .then(() => {
        setCode('');
        onClose();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not import the agent.');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal title="Import from metro.box" open={open} onClose={close}>
      <Col gap={14}>
        <Text size="sm" role="secondary">
          {HOW}
        </Text>
        <Input
          name="pairing-code"
          value={code}
          placeholder="ma_…"
          disabled={busy}
          dark={dark}
          onChangeText={setCode}
          onSubmit={submit}
          style={GROW}
        />
        {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
        <Row justify="between" align="center" gap={12} wrap>
          <Button color="secondary" dark={dark} disabled={busy} onPress={close} label="Cancel" />
          <Button
            color="primary"
            dark={dark}
            onPress={submit}
            loading={busy}
            disabled={busy || code.trim() === ''}
            label="Import"
          />
        </Row>
      </Col>
    </Modal>
  );
}
