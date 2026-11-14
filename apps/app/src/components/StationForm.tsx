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
  return !form.interactive && form.fields.length === 0 ? 'Generate and connect' : 'Connect';
}

interface StationFormProps {
  station: string;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onStart: (fields: Record<string, string>) => void;
}

export function StationForm(props: StationFormProps): ReactNode {
  const { station, busy, error, onBack, onStart } = props;
  const [values, setValues] = useState<Record<string, string>>({});
  const form = STATION_FORMS[station];
  if (form === undefined) return null;
  const complete = ready(form, values);

  const submit = (): void => {
    if (busy || !complete) return;
    onStart(trimmed(form, values));
  };

  return (
    <Column gap={24}>
      <Column gap={8}>
        <Text accessibilityRole="header" size="2xl" fontWeight="semibold">{stationLabel(station)}</Text>
        <LinkedText text={form.hint} links={form.links ?? []} />
      </Column>
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
