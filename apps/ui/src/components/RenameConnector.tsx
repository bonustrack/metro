import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui';
import { GROW } from '../theme';
import { Modal } from './Modal';
import { renameConnector, type Connector } from '../api/connectors';
import { queryError } from '../api/queries';

interface RenameConnectorProps {
  token: string;
  connector: Connector;
  open: boolean;
  onClose: () => void;
  onRenamed: () => void;
}

export function RenameConnector({
  token,
  connector,
  open,
  onClose,
  onRenamed,
}: RenameConnectorProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [name, setName] = useState(connector.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (): void => {
    if (busy) return;
    setError(null);
    onClose();
  };

  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    setError(null);
    renameConnector(token, connector.id, trimmed)
      .then(() => {
        onRenamed();
        onClose();
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not rename the connector.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal title="Rename connector" open={open} onClose={close}>
      <Col gap={14}>
        <Input
          name="connector-name"
          value={name}
          placeholder={connector.name}
          disabled={busy}
          dark={dark}
          onChangeText={setName}
          onSubmit={submit}
          style={GROW}
        />
        {error === null ? null : (
          <Text size="sm" role="danger">
            {error}
          </Text>
        )}
        <Row justify="between" align="center" gap={12} wrap>
          <Button
            color="secondary"
            dark={dark}
            disabled={busy}
            onPress={close}
            label="Cancel"
          />
          <Button
            color="primary"
            dark={dark}
            onPress={submit}
            loading={busy}
            disabled={busy || name.trim() === ''}
            label="Rename"
          />
        </Row>
      </Col>
    </Modal>
  );
}
