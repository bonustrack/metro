import { useState, type ReactNode } from 'react';
import { Pressable } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { FormField } from './FormField.js';
import { Icon } from './Icon.js';
import { Modal, ModalText } from './Modal.js';
import { Actions } from './ui/Actions.js';
import { ICON_SIZE } from './ui/sizes.js';
import { confirmMatches, confirmPrompt } from './confirm.js';
import { copyText } from '../lib/clipboard.js';
import { GROW, MONO } from '../lib/style.js';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  lines: string[];
  confirmWord: string;
  confirmLabel: string;
  busy: boolean;
  blocked?: boolean;
  error: string | null;
  children?: ReactNode;
  onClose: () => void;
  onConfirm: (typed: string) => void;
}

function TypeWord({ word }: { word: string }): ReactNode {
  const palette = useKitPalette();
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    copyText(word).then(setCopied).catch(() => undefined);
  };
  return (
    <Row align="center" gap={6} wrap>
      <Text size="xs" role="secondary">Type</Text>
      <Text size="xs" weight="semibold" style={MONO} selectable>
        {word}
      </Text>
      <Text size="xs" role="secondary">to confirm</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={copied ? `Copied ${word}` : `Copy ${word}`} hitSlop={8} onPress={copy}>
        <Icon name={copied ? 'check' : 'copy'} size={ICON_SIZE.sm} color={palette.sub} />
      </Pressable>
    </Row>
  );
}

export function ConfirmModal(props: ConfirmModalProps): ReactNode {
  const { open, title, lines, confirmWord, confirmLabel, busy } = props;
  const dark = useKitScheme() === 'dark';
  const [typed, setTyped] = useState('');
  const matches = confirmMatches(typed, confirmWord) && props.blocked !== true;
  const close = (): void => {
    setTyped('');
    props.onClose();
  };
  const confirm = (): void => {
    if (!matches || busy) return;
    props.onConfirm(typed.trim());
  };
  return (
    <Modal title={title} open={open} onClose={close}>
      <Col gap={20}>
        {lines.map((line) => (
          <ModalText key={line}>{line}</ModalText>
        ))}
        {props.children}
        <Col gap={8}>
          <TypeWord word={confirmWord} />
          <FormField label={confirmPrompt(confirmWord)} labelHidden name="confirm-word" value={typed} placeholder={confirmWord} disabled={busy} dark={dark} onChangeText={setTyped} onSubmit={confirm} style={GROW} inputProps={{ autoCapitalize: 'none', autoCorrect: false, spellCheck: false, autoComplete: 'off' }} />
        </Col>
        <Actions error={props.error} cancel={{ onPress: close, disabled: busy }} main={{ label: confirmLabel, danger: true, busy, disabled: !matches, onPress: confirm }} />
      </Col>
    </Modal>
  );
}
