import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { GROW } from '../theme.js';
import {
  connectorCallbackUrl,
  createConnector,
  type Connector,
  type NewConnector,
} from '../api/connectors.js';
import { useMachineQuery } from '../api/queries.js';
import { Modal } from './Modal.js';

type FieldKey = keyof NewConnector;

const EMPTY: NewConnector = {
  name: '',
  url: '',
  header: '',
  value: '',
  clientId: '',
  clientSecret: '',
};

const HINT =
  'Metro verifies the server from its own machine, so a localhost URL will never work. The name becomes the key in the JSON you paste into your MCP client. Leave the header empty if the server signs you in with OAuth — Metro will send you there.';

const APP_HINT =
  'Only for a server whose sign-in does not register clients on its own, such as Microsoft 365: register an app with it, give the app this redirect URL, and paste the app\'s client ID here. A secret is needed only when the app was registered as a web app.';

interface FieldSpec {
  key: FieldKey;
  label: string;
  placeholder: string;
  secret?: boolean;
}

const FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Name', placeholder: 'linear' },
  { key: 'url', label: 'URL', placeholder: 'https://mcp.linear.app/mcp' },
  { key: 'header', label: 'Header (optional)', placeholder: 'Authorization' },
  { key: 'value', label: 'Value (optional)', placeholder: 'Bearer sk-…', secret: true },
];

const APP_FIELDS: FieldSpec[] = [
  {
    key: 'clientId',
    label: 'Client ID (optional)',
    placeholder: '00000000-0000-0000-0000-000000000000',
  },
  { key: 'clientSecret', label: 'Client secret (optional)', placeholder: '', secret: true },
];

function trimmed(values: NewConnector): NewConnector {
  return {
    name: values.name.trim(),
    url: values.url.trim(),
    header: values.header.trim(),
    value: values.value.trim(),
    clientId: values.clientId.trim(),
    clientSecret: values.clientSecret.trim(),
  };
}

interface FormFieldProps {
  label: string;
  name: string;
  value: string;
  placeholder: string;
  secret?: boolean;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}

function FormField(props: FormFieldProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={4}>
      <Text size="sm" role="secondary">{props.label}</Text>
      <Input
        name={props.name}
        value={props.value}
        placeholder={props.placeholder}
        inputType={props.secret === true ? 'password' : 'text'}
        disabled={props.busy}
        dark={dark}
        onChangeText={props.onChange}
        onSubmit={props.onSubmit}
        style={GROW}
      />
    </Col>
  );
}

interface FieldsProps {
  specs: FieldSpec[];
  values: NewConnector;
  busy: boolean;
  onChange: (key: FieldKey) => (value: string) => void;
  onSubmit: () => void;
}

function Fields({ specs, values, busy, onChange, onSubmit }: FieldsProps): ReactNode {
  return specs.map((spec) => (
    <FormField
      key={spec.key}
      label={spec.label}
      name={`connector-${spec.key}`}
      value={values[spec.key]}
      placeholder={spec.placeholder}
      secret={spec.secret === true}
      busy={busy}
      onChange={onChange(spec.key)}
      onSubmit={onSubmit}
    />
  ));
}

interface ConnectorFormProps {
  onAdded: (result: Connector) => void;
  onCancel: () => void;
}

function ConnectorForm({
  onAdded,
  onCancel,
}: ConnectorFormProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const machine = useMachineQuery().data;
  const [values, setValues] = useState<NewConnector>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const complete = values.name.trim() !== '' && values.url.trim() !== '';

  const change =
    (key: FieldKey) =>
    (value: string): void => {
      setValues((prev) => ({ ...prev, [key]: value }));
    };

  const submit = (): void => {
    if (busy || !complete) return;
    setBusy(true);
    setError(null);
    createConnector(trimmed(values))
      .then((result) => {
        if (result.kind === 'oauth') {
          window.location.assign(result.authorizeUrl);
          return;
        }
        onAdded(result.connector);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not add the connector.');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Col gap={14}>
      <Text size="sm" role="secondary">{HINT}</Text>
      <Col gap={10}>
        <Fields specs={FIELDS} values={values} busy={busy} onChange={change} onSubmit={submit} />
      </Col>
      <Col gap={10}>
        <Text size="sm" role="secondary">{APP_HINT}</Text>
        {machine === undefined ? null : (
          <Text size="sm">{connectorCallbackUrl(machine)}</Text>
        )}
        <Fields specs={APP_FIELDS} values={values} busy={busy} onChange={change} onSubmit={submit} />
      </Col>
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
      <Row justify="between" align="center" gap={12} wrap>
        <Button
          color="secondary"
          dark={dark}
          onPress={onCancel}
          disabled={busy}
          label="Cancel"
        />
        <Button
          color="primary"
          dark={dark}
          onPress={submit}
          loading={busy}
          disabled={busy || !complete}
          label="Add"
        />
      </Row>
    </Col>
  );
}

interface AddConnectorProps {
  open: boolean;
  onClose: () => void;
  onAdded: (id: string) => void;
}

export function AddConnector(props: AddConnectorProps): ReactNode {
  const { open, onClose, onAdded } = props;

  return (
    <Modal title="Add connector" open={open} onClose={onClose}>
      <ConnectorForm
        onCancel={onClose}
        onAdded={(result) => {
          onClose();
          onAdded(result.id);
        }}
      />
    </Modal>
  );
}
