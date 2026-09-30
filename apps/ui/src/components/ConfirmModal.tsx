import { useState, type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { FormField } from './FormField.js';
import { Text } from '@stage-labs/kit/react-native/text';
import { GROW } from '../theme.js';
import { Modal } from '@stage-labs/kit/react-native/modal';
import { confirmMatches, confirmPrompt } from './confirm.js';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  lines: string[];
  confirmWord: string;
  confirmLabel: string;
  busy: boolean;
  blocked?: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (typed: string) => void;
}

export function ConfirmModal(props: ConfirmModalProps): ReactNode {
  const { open, title, lines, confirmWord, confirmLabel } = props;
  const dark = useKitScheme() === 'dark';
  const [typed, setTyped] = useState('');
  const matches = confirmMatches(typed, confirmWord) && props.blocked !== true;

  const close = (): void => {
    setTyped('');
    props.onClose();
  };

  const confirm = (): void => {
    if (!matches || props.busy) return;
    props.onConfirm(typed.trim());
  };

  return (
    <Modal title={title} open={open} onClose={close}>
      <Col gap={14}>
        {lines.map((line) => (
          <Text key={line} size="md" role="secondary">{line}</Text>
        ))}
        <Col gap={4}>
          <FormField label={confirmPrompt(confirmWord)}
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
          <Text size="md" role="danger">{props.error}</Text>
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
