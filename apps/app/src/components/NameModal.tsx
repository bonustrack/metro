import { type ReactNode, useState } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { FormField } from './FormField.js';
import { Modal } from './Modal.js';
import { Actions } from './ui/Actions.js';
import { GROW } from '../lib/style.js';
import { queryError } from '../lib/queries.js';

interface NameModalProps {
  title: string;
  action: string;
  placeholder: string;
  field?: string;
  initial?: string;
  failure: string;
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string) => Promise<unknown>;
}

export function NameModal({ title, action, placeholder, field = 'Name', initial = '', failure, open, onClose, onSubmit }: NameModalProps): ReactNode {
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
      <Column gap={20}>
        <FormField label={field} name="name" value={name} placeholder={placeholder} disabled={busy} onChangeText={setName} onSubmit={submit} style={GROW} />
        <Actions error={error} cancel={{ onPress: close, disabled: busy }} main={{ label: action, busy, disabled: name.trim() === '', onPress: submit }} />
      </Column>
    </Modal>
  );
}
