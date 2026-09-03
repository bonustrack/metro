import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { Modal } from './Modal';
import { ConnectorChooser } from './ConnectorChooser';
import { queryError } from '../api/queries';

interface AddConnectorsProps {
  token: string;
  project: string;
  title: string;
  action: string;
  initial: string[];
  open: boolean;
  onClose: () => void;
  onSubmit: (connectorIds: string[]) => Promise<unknown>;
}

export function AddConnectors({
  token,
  project,
  title,
  action,
  initial,
  open,
  onClose,
  onSubmit,
}: AddConnectorsProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [staged, setStaged] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = staged ?? initial;

  const close = (): void => {
    if (busy) return;
    setStaged(null);
    setError(null);
    onClose();
  };

  const toggle = (id: string): void => {
    setStaged(
      chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id],
    );
  };

  const submit = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    onSubmit(chosen)
      .then(() => {
        setStaged(null);
        onClose();
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not save that.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal title={title} open={open} onClose={close}>
      <Col gap={14}>
        <ConnectorChooser token={token} project={project} chosen={chosen} onToggle={toggle} />
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
            loading={busy}
            disabled={busy}
            onPress={submit}
            label={action}
          />
        </Row>
      </Col>
    </Modal>
  );
}
