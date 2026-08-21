import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui';
import {
  connectorHost,
  createConnector,
  serverLabel,
  type Connector,
  type NewConnector,
} from '../api/connectors';
import { CopyBlock } from './CopyBlock';
import { Field } from './Field';
import { Modal } from './Modal';

type Step = { kind: 'form' } | { kind: 'done'; result: Connector };

type FieldKey = keyof NewConnector;

const EMPTY: NewConnector = { name: '', url: '', header: '', value: '' };

const HINT =
  'Metro verifies the server from its own machine, so a localhost URL will never work. The name becomes the key in the JSON you paste into your MCP client.';

function trimmed(values: NewConnector): NewConnector {
  return {
    name: values.name.trim(),
    url: values.url.trim(),
    header: values.header.trim(),
    value: values.value.trim(),
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
        style={{ flexGrow: 1, minWidth: 0 }}
      />
    </Col>
  );
}

interface ConnectorFormProps {
  token: string;
  onAdded: (result: Connector) => void;
  onCancel: () => void;
}

function ConnectorForm({ token, onAdded, onCancel }: ConnectorFormProps): ReactNode {
  const dark = useKitScheme() === 'dark';
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
    createConnector(token, trimmed(values))
      .then(onAdded)
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
        <FormField
          label="Name"
          name="connector-name"
          value={values.name}
          placeholder="linear"
          busy={busy}
          onChange={change('name')}
          onSubmit={submit}
        />
        <FormField
          label="URL"
          name="connector-url"
          value={values.url}
          placeholder="https://mcp.linear.app/mcp"
          busy={busy}
          onChange={change('url')}
          onSubmit={submit}
        />
        <FormField
          label="Header (optional)"
          name="connector-header"
          value={values.header}
          placeholder="Authorization"
          busy={busy}
          onChange={change('header')}
          onSubmit={submit}
        />
        <FormField
          label="Value (optional)"
          name="connector-value"
          value={values.value}
          placeholder="Bearer sk-…"
          secret
          busy={busy}
          onChange={change('value')}
          onSubmit={submit}
        />
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
          label="Connect"
        />
      </Row>
    </Col>
  );
}

function AddedConnector({
  result,
  onDismiss,
}: {
  result: Connector;
  onDismiss: () => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  const verified = result.verified;
  return (
    <Col gap={14}>
      <Col gap={4}>
        <Text size="lg" weight="semibold">{result.name} connected</Text>
        <Text size="sm" role="secondary">
          Metro reached {connectorHost(result.url)} and it answered as an MCP
          server. Paste the block below into your MCP client config.
        </Text>
      </Col>
      {verified === null ? null : (
        <Row gap={20} wrap>
          <Field label="tools" value={String(verified.tools)} />
          <Field label="server" value={serverLabel(verified)} />
          <Field label="protocol" value={verified.protocol} />
        </Row>
      )}
      <CopyBlock
        key={result.json}
        label="mcp config"
        value={result.json}
        secret={result.secret !== null}
        hide={result.secret}
      />
      <Row justify="end">
        <Button color="secondary" dark={dark} onPress={onDismiss} label="Done" />
      </Row>
    </Col>
  );
}

interface AddConnectorProps {
  token: string;
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}

export function AddConnector(props: AddConnectorProps): ReactNode {
  const { token, open, onClose, onAdded } = props;
  const [step, setStep] = useState<Step>({ kind: 'form' });

  const close = (): void => {
    setStep({ kind: 'form' });
    onClose();
  };

  return (
    <Modal title="Add connector" open={open} onClose={close}>
      {step.kind === 'form' ? (
        <ConnectorForm
          token={token}
          onCancel={close}
          onAdded={(result) => {
            setStep({ kind: 'done', result });
            onAdded();
          }}
        />
      ) : null}

      {step.kind === 'done' ? (
        <AddedConnector result={step.result} onDismiss={close} />
      ) : null}
    </Modal>
  );
}
