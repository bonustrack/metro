import { type ReactNode, useState } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { queryError } from '../api/queries.js';

export interface Saving {
  value: string;
  setValue: (value: string) => void;
  busy: boolean;
  error: string | null;
  saved: boolean;
  ready: boolean;
  save: () => void;
}

interface SaveJob {
  initial: string;
  clean?: (value: string) => string;
  valid: (value: string) => boolean;
  run: (value: string) => Promise<unknown>;
  failure: string;
}

const trimmed = (value: string): string => value.trim();

export function useSave({ initial, clean = trimmed, valid, run, failure }: SaveJob): Saving {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const next = clean(value);
  const ready = valid(next) && next !== initial;
  const save = (): void => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    run(next)
      .then(() => {
        setSaved(true);
      })
      .catch((err: unknown) => {
        setError(queryError(err, failure));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { value, setValue, busy, error, saved, ready, save };
}

interface SaveFieldProps {
  saving: Saving;
  name: string;
  placeholder?: string;
  editable?: boolean;
}

export function SaveField({ saving, name, placeholder, editable = true }: SaveFieldProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <>
      <Row gap={8} align="center" wrap>
        <Input
          name={name}
          value={saving.value}
          placeholder={placeholder}
          dark={dark}
          disabled={saving.busy || !editable}
          onChangeText={saving.setValue}
        />
        {editable && (saving.ready || saving.busy) ? (
          <Button color="primary" dark={dark} label={saving.busy ? 'Saving…' : 'Save'} loading={saving.busy} disabled={saving.busy} onPress={saving.save} />
        ) : null}
      </Row>
      {saving.error !== null ? <Text size="sm" role="danger">{saving.error}</Text> : saving.saved ? <Text size="sm" role="secondary">Saved.</Text> : null}
    </>
  );
}
