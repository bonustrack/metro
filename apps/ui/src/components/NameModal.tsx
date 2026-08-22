import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui';
import { GROW } from '../theme';
import { Modal } from './Modal';
import { queryError } from '../api/queries';

interface NameModalProps {
  title: string;
  action: string;
  placeholder: string;
  initial?: string;
  failure: string;
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string) => Promise<unknown>;
}

export function NameModal({
  title,
  action,
  placeholder,
  initial = '',
  failure,
  open,
  onClose,
  onSubmit,
}: NameModalProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [name, setName] = useState(initial);
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
    onSubmit(trimmed)
      .then(() => {
        onClose();
      })
      .catch((err: unknown) => {
        setError(queryError(err, failure));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal title={title} open={open} onClose={close}>
      <Col gap={14}>
        <Input
          name="name"
          value={name}
          placeholder={placeholder}
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
            label={action}
          />
        </Row>
      </Col>
    </Modal>
  );
}
