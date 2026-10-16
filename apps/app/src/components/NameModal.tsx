import { type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { FormField } from './FormField.js';
import { Modal, ModalText } from './Modal.js';
import { Actions } from './ui/Actions.js';
import { GROW } from '../lib/style.js';
import { queryError } from '../lib/queries.js';

interface NameModalProps {
  title: string;
  action: string;
  placeholder: string;
  text?: string;
  field?: string;
  initial?: string;
  failure: string;
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string) => Promise<unknown>;
}

export function NameModal({ title, action, placeholder, text, field = 'Name', initial = '', failure, open, onClose, onSubmit }: NameModalProps): ReactNode {
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
      <Col gap={20}>
        {text === undefined ? null : <ModalText>{text}</ModalText>}
        <FormField label={field} name="name" value={name} placeholder={placeholder} disabled={busy} dark={dark} onChangeText={setName} onSubmit={submit} style={GROW} />
        <Actions error={error} cancel={{ onPress: close, disabled: busy }} main={{ label: action, busy, disabled: name.trim() === '', onPress: submit }} />
      </Col>
    </Modal>
  );
}
