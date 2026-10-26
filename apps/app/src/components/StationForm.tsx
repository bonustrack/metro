import { type ReactNode, useState } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { FormField } from './FormField.js';
import { Text } from '@stage-labs/kit/react-native/text';
import { GROW } from '../lib/style.js';
import {
  stationLabel,
  STATION_FORMS,
  type AttachField,
  type StationForm as Form,
} from '@metro-labs/client/api/attach';
import { gmailConnectFields, gmailForm, type GmailMode } from '@metro-labs/client/api/gmail';
import { Choice } from './Choice.js';
import { LinkedText } from './LinkedText.js';
import { Actions } from './ui/Actions.js';

function kindOf(field: AttachField): { variant?: 'obscured' | 'number'; inputType?: 'tel' } {
  if (field.secret) return { variant: 'obscured' };
  if (field.kind === 'number') return { variant: 'number' };
  return field.kind === 'tel' ? { inputType: 'tel' } : {};
}

function ready(form: Form, values: Record<string, string>): boolean {
  return form.fields.every(
    (f) => f.optional === true || (values[f.key] ?? '').trim() !== '',
  );
}

function trimmed(form: Form, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of form.fields) {
    const value = (values[field.key] ?? '').trim();
    if (value !== '') out[field.key] = value;
  }
  return out;
}

function submitLabel(form: Form): string {
  if (form.interactive) return 'Start sign-in';
  return form.fields.length === 0 ? 'Generate and connect' : 'Connect';
}

interface StationFormProps {
  station: string;
  gmailManaged: boolean;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onStart: (fields: Record<string, string>) => void;
}

export function StationForm(props: StationFormProps): ReactNode {
  const { station, gmailManaged, busy, error, onBack, onStart } = props;
  const [values, setValues] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<GmailMode>('managed');
  const form = station === 'gmail' ? gmailForm(gmailManaged, mode) : STATION_FORMS[station];
  if (form === undefined) return null;
  const complete = ready(form, values);

  const submit = (): void => {
    if (busy || !complete) return;
    const fields = trimmed(form, values);
    onStart(station === 'gmail' ? gmailConnectFields(gmailManaged, mode, fields) : fields);
  };

  return (
    <Column gap={24}>
      <Column gap={8}>
        <Text accessibilityRole="header" size="2xl" fontWeight="semibold">{stationLabel(station)}</Text>
        <LinkedText text={form.hint} links={form.links ?? []} />
      </Column>
      {station !== 'gmail' || !gmailManaged ? null : (
        <Choice<GmailMode>
          label="Gmail connection"
          value={mode}
          options={[{ value: 'managed', label: 'With Google' }, { value: 'byo', label: 'Advanced: own client' }]}
          disabled={busy}
          onChange={setMode}
        />
      )}
      <Column gap={10}>
        {form.fields.map((field) => (
          <Column key={field.key} gap={4}>
            <FormField
              label={field.label}
              name={`attach-${field.key}`}
              value={values[field.key] ?? ''}
              placeholder={field.placeholder}
              {...kindOf(field)}
              disabled={busy}
              onChangeText={(value) => {
                setValues((prev) => ({ ...prev, [field.key]: value }));
              }}
              onSubmit={submit}
              style={GROW}
            />
            {field.hint === undefined ? null : <Text size="xs" color="secondary">{field.hint}</Text>}
          </Column>
        ))}
      </Column>
      <Actions error={error} cancel={{ label: 'Back', onPress: onBack, disabled: busy }} main={{ label: submitLabel(form), busy, disabled: !complete, onPress: submit }} />
    </Column>
  );
}
