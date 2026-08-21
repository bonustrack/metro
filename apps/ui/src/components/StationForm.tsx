import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui';
import { GROW } from '../theme';
import {
  startAttach,
  stationLabel,
  STATION_FORMS,
  type AttachField,
  type AttachResult,
  type StationForm as Form,
} from '../api/attach';
import { type AttachSession } from '../api/attach-session';
import { LinkedText } from './LinkedText';

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
  token: string;
  agentId: string;
  station: string;
  onBack: () => void;
  onAttached: (result: AttachResult) => void;
  onPending: (session: AttachSession) => void;
}

export function StationForm(props: StationFormProps): ReactNode {
  const { token, agentId, station, onBack, onAttached, onPending } = props;
  const dark = useKitScheme() === 'dark';
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = STATION_FORMS[station];
  if (form === undefined) return null;
  const complete = ready(form, values);

  const submit = (): void => {
    if (busy || !complete) return;
    setBusy(true);
    setError(null);
    startAttach(token, agentId, station, trimmed(form, values))
      .then((started) => {
        if (started.kind === 'pending') onPending(started.session);
        else onAttached(started.result);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not attach the station.');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Col gap={14}>
      <Col gap={2}>
        <Text size="lg" weight="semibold">{stationLabel(station)}</Text>
        <LinkedText text={form.hint} links={form.links ?? []} />
      </Col>
      <Col gap={10}>
        {form.fields.map((field) => (
          <Col key={field.key} gap={4}>
            <Text size="sm" role="secondary">{field.label}</Text>
            <Input
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
          </Col>
        ))}
      </Col>
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
      <Row justify="between" align="center" gap={12} wrap>
        <Button
          color="secondary"
          dark={dark}
          onPress={onBack}
          disabled={busy}
          label="Back"
        />
        <Button
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
