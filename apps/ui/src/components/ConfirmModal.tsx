import { useState, type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui';
import { Modal } from './Modal';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  lines: string[];
  prompt: string;
  confirmWord: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function ConfirmModal(props: ConfirmModalProps): ReactNode {
  const { open, title, lines, prompt, confirmWord, confirmLabel } = props;
  const dark = useKitScheme() === 'dark';
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === confirmWord;

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
          <Text size="sm" role="secondary">{prompt}</Text>
          <Input
            name="confirm-word"
            value={typed}
            placeholder={confirmWord}
            disabled={props.busy}
            dark={dark}
            onChangeText={setTyped}
            onSubmit={confirm}
            style={{ flexGrow: 1, minWidth: 0 }}
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
