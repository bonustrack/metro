import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Modal, ModalText } from '../Modal.js';
import { Actions } from '../ui/Actions.js';

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
  return (
    <Modal title={title} open={open} onClose={onClose}>
      <Col gap={20}>
        {lines.map((line) => (
          <ModalText key={line}>{line}</ModalText>
        ))}
        <Actions error={error} cancel={{ onPress: onClose, disabled: busy }} main={{ label: action, busy, onPress: onConfirm }} />
      </Col>
    </Modal>
  );
}
