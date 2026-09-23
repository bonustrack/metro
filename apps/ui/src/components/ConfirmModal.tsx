import { useState, type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { GROW } from '../theme.js';
import { Modal } from './Modal.js';
import { confirmMatches, confirmPrompt } from './confirm.js';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  lines: string[];
  confirmWord: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function ConfirmModal(props: ConfirmModalProps): ReactNode {
  const { open, title, lines, confirmWord, confirmLabel } = props;
  const dark = useKitScheme() === 'dark';
  const [typed, setTyped] = useState('');
  const matches = confirmMatches(typed, confirmWord);

  const close = (): void => {
    setTyped('');
    props.onClose();
  };

  const confirm = (): void => {
    if (!matches || props.busy) return;
    props.onConfirm();
  };

  return (
    <Modal title={title} open={open} onClose={close}>
      <Col gap={14}>
        {lines.map((line) => (
          <Text key={line} size="sm" role="secondary">{line}</Text>
        ))}
        <Col gap={4}>
          <Text size="sm" role="secondary">{confirmPrompt(confirmWord)}</Text>
          <Input
            name="confirm-word"
            value={typed}
            placeholder={confirmWord}
            disabled={props.busy}
            dark={dark}
            onChangeText={setTyped}
            onSubmit={confirm}
            style={GROW}
          />
        </Col>
        {props.error !== null ? (
          <Text size="sm" role="danger">{props.error}</Text>
        ) : null}
        <Row justify="between" align="center" gap={12} wrap>
          <Button color="secondary" dark={dark} disabled={props.busy} onPress={close} label="Cancel" />
          <Button
            color="danger"
            dark={dark}
            onPress={confirm}
            loading={props.busy}
            disabled={props.busy || !matches}
            label={confirmLabel}
          />
        </Row>
      </Col>
    </Modal>
  );
}
