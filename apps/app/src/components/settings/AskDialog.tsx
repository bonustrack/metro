import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Modal } from '../Modal.js';

interface AskDialogProps {
  open: boolean;
  title: string;
  lines: string[];
  action: string;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function AskDialog({ open, title, lines, action, busy = false, error = null, onClose, onConfirm }: AskDialogProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Modal title={title} open={open} onClose={onClose}>
      <Col gap={14}>
        {lines.map((line) => (
          <Text key={line} size="md" role="secondary">
            {line}
          </Text>
        ))}
        {error === null ? null : (
          <Text size="md" role="danger">
            {error}
          </Text>
        )}
        <Row justify="between" align="center" gap={12} wrap>
          <Button color="secondary" dark={dark} disabled={busy} label="Cancel" onPress={onClose} />
          <Button color="primary" dark={dark} loading={busy} disabled={busy} label={action} onPress={onConfirm} />
        </Row>
      </Col>
    </Modal>
  );
}
