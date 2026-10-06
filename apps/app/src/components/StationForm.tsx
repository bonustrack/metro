import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
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

const inputType = (field: AttachField): 'password' | 'number' | 'tel' | 'text' =>
  field.secret ? 'password' : field.kind;

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
  const dark = useKitScheme() === 'dark';
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
    <Col gap={14}>
      <Col gap={2}>
        <Text size="md" weight="semibold">{stationLabel(station)}</Text>
        <LinkedText text={form.hint} links={form.links ?? []} />
      </Col>
      {station !== 'gmail' || !gmailManaged ? null : (
        <Choice<GmailMode>
          label="Gmail connection"
          value={mode}
          options={[{ value: 'managed', label: 'With Google' }, { value: 'byo', label: 'Advanced: own client' }]}
          disabled={busy}
          onChange={setMode}
        />
      )}
      <Col gap={10}>
        {form.fields.map((field) => (
          <Col key={field.key} gap={4}>
            <FormField
              label={field.label}
              name={`attach-${field.key}`}
              value={values[field.key] ?? ''}
              placeholder={field.placeholder}
              inputType={inputType(field)}
              disabled={busy}
              dark={dark}
              onChangeText={(value) => {
                setValues((prev) => ({ ...prev, [field.key]: value }));
              }}
              onSubmit={submit}
              style={GROW}
            />
            {field.hint === undefined ? null : <Text size="2xs" role="secondary">{field.hint}</Text>}
          </Col>
        ))}
      </Col>
      {error !== null ? <Text size="2xs" role="danger">{error}</Text> : null}
      <Row justify="between" align="center" gap={12} wrap>
        <Button
          color="secondary"
          dark={dark}
          onPress={onBack}
          disabled={busy}
          label="Back"
        />
        <Button size="lg"
          color="primary"
          dark={dark}
          onPress={submit}
          loading={busy}
          disabled={busy || !complete}
          label={submitLabel(form)}
        />
      </Row>
    </Col>
  );
}
