import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Button } from '@stage-labs/kit/react-native/button';
import { Card } from '@stage-labs/kit/react-native/card';
import { Input } from '@stage-labs/kit/react-native/input';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import {
  startAttach,
  STATION_FORMS,
  type AttachField,
  type AttachResult,
  type StationForm,
} from '../api/attach';
import { type AttachSession } from '../api/attach-session';
import { StationPicker } from './StationPicker';

interface AttachAccountProps {
  token: string;
  agentId: number;
  attachable: string[];
  onAttached: (result: AttachResult) => void;
  onPending: (session: AttachSession) => void;
}

const inputType = (field: AttachField): 'password' | 'number' | 'tel' | 'text' =>
  field.secret ? 'password' : field.kind;

function ready(form: StationForm, values: Record<string, string>): boolean {
  return form.fields.every(
    (f) => f.optional === true || (values[f.key] ?? '').trim() !== '',
  );
}

function trimmed(
  form: StationForm,
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of form.fields) {
    const value = (values[field.key] ?? '').trim();
    if (value !== '') out[field.key] = value;
  }
  return out;
}

function FormFields({
  form,
  values,
  busy,
  onChange,
  onSubmit,
}: {
  form: StationForm;
  values: Record<string, string>;
  busy: boolean;
  onChange: (key: string, value: string) => void;
  onSubmit: () => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={10}>
      {form.fields.map((field) => (
        <Col key={field.key} gap={4}>
          <Text size="2xs" role="secondary">
            {field.label}
          </Text>
          <Input
            name={`attach-${field.key}`}
            value={values[field.key] ?? ''}
            placeholder={field.placeholder}
            inputType={inputType(field)}
            disabled={busy}
            dark={dark}
            onChangeText={(value) => {
              onChange(field.key, value);
            }}
            onSubmit={onSubmit}
            style={{ flexGrow: 1, minWidth: 260 }}
          />
        </Col>
      ))}
    </Col>
  );
}

export function AttachAccount(props: AttachAccountProps): ReactNode {
  const { token, agentId, attachable, onAttached, onPending } = props;
  const dark = useKitScheme() === 'dark';
  const known = attachable.filter((s) => STATION_FORMS[s] !== undefined);
  const [picked, setPicked] = useState(known[0] ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = STATION_FORMS[picked];
  if (known.length === 0 || form === undefined) return null;
  const complete = ready(form, values);

  const submit = (): void => {
    if (busy || !complete) return;
    setBusy(true);
    setError(null);
    startAttach(token, agentId, picked, trimmed(form, values))
      .then((started) => {
        setValues({});
        if (started.kind === 'pending') onPending(started.session);
        else onAttached(started.result);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : 'Could not attach the account.',
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Card dark={dark} padding={18}>
      <Col gap={12}>
        <Col gap={2}>
          <Text size="lg" weight="semibold">
            Connect an account
          </Text>
          <Text size="sm" role="secondary">
            {form.hint}
          </Text>
        </Col>
        <StationPicker
          stations={known}
          picked={picked}
          disabled={busy}
          onPick={(station) => {
            setPicked(station);
            setValues({});
            setError(null);
          }}
        />
        <FormFields
          form={form}
          values={values}
          busy={busy}
          onChange={(key, value) => {
            setValues((prev) => ({ ...prev, [key]: value }));
          }}
          onSubmit={submit}
        />
        <Row justify="end">
          <Button
            color="primary"
            dark={dark}
            onPress={submit}
            loading={busy}
            disabled={busy || !complete}
            label={
              form.interactive
                ? 'Start sign-in'
                : form.fields.length === 0
                  ? 'Generate and connect'
                  : 'Connect'
            }
          />
        </Row>
        {error !== null ? (
          <Text size="sm" role="danger">
            {error}
          </Text>
        ) : null}
      </Col>
    </Card>
  );
}
