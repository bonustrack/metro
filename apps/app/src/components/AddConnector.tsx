import { type ReactNode, useState } from 'react';
import { Pressable } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { FormField } from './FormField.js';
import { Text } from '@stage-labs/kit/react-native/text';
import { Modal } from './Modal.js';
import { goExternal } from '../lib/open.js';
import type { NewOrgConnector } from '@metro-labs/client/api/org-connectors';
import { PublicOAuthResource } from './PublicOAuthResource.js';
import { inNewTab } from './sign-in-tab.js';
import { TextLink } from './TextLink.js';

type FormValues = Omit<NewOrgConnector, 'oauthResource'>;
type FieldKey = keyof FormValues;

const EMPTY: FormValues = {
  name: '',
  url: '',
  header: '',
  value: '',
  clientId: '',
  clientSecret: '',
};

export interface AddedConnector {
  id: string;
  authorizeUrl: string | null;
}

const APP_HINT = 'For servers like Microsoft 365 only: register an app with this redirect url and paste its client id.';

interface FieldSpec {
  key: FieldKey;
  label: string;
  placeholder: string;
  secret?: boolean;
}

const FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Name', placeholder: 'linear' },
  { key: 'url', label: 'URL', placeholder: 'https://mcp.linear.app/mcp' },
];

const HEADER_FIELDS: FieldSpec[] = [
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

function trimmed(values: FormValues): FormValues {
  return {
    name: values.name.trim(),
    url: values.url.trim(),
    header: values.header.trim(),
    value: values.value.trim(),
    clientId: values.clientId.trim(),
    clientSecret: values.clientSecret.trim(),
  };
}

interface FieldsProps {
  specs: FieldSpec[];
  values: FormValues;
  busy: boolean;
  onChange: (key: FieldKey) => (value: string) => void;
  onSubmit: () => void;
}

function Fields({ specs, values, busy, onChange, onSubmit }: FieldsProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return specs.map((spec) => (
    <FormField
      key={spec.key}
      label={spec.label}
      name={`connector-${spec.key}`}
      value={values[spec.key]}
      placeholder={spec.placeholder}
      inputType={spec.secret === true ? 'password' : 'text'}
      disabled={busy}
      dark={dark}
      onChangeText={onChange(spec.key)}
      onSubmit={onSubmit}
    />
  ));
}

interface AdvancedProps {
  fields: FieldsProps;
  callbackUrl: string | null;
  publicOAuth: boolean;
  oauth: { value: string; onChange: (value: string) => void };
}

function Advanced({ fields, callbackUrl, publicOAuth, oauth }: AdvancedProps): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => { setOpen(!open); }}>
        <Text size="md" role="link">{open ? 'Hide advanced' : 'Advanced'}</Text>
      </Pressable>
      {open ? (
        <Col gap={10}>
          <Fields {...fields} specs={HEADER_FIELDS} />
          <Text size="md" role="secondary">{APP_HINT}</Text>
          {callbackUrl === null ? null : <Text size="md">{callbackUrl}</Text>}
          <Fields {...fields} specs={APP_FIELDS} />
          {publicOAuth ? <PublicOAuthResource value={oauth.value} disabled={fields.busy} onChange={oauth.onChange} /> : null}
        </Col>
      ) : null}
    </>
  );
}

interface ConnectorFormProps {
  hint: string;
  callbackUrl: string | null;
  create: (values: NewOrgConnector) => Promise<AddedConnector>;
  allowPublicOAuthResource?: boolean;
  onAdded: (id: string) => void;
  onCancel: () => void;
}

function ConnectorForm({
  hint,
  callbackUrl,
  allowPublicOAuthResource = false,
  create,
  onAdded,
  onCancel,
}: ConnectorFormProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [values, setValues] = useState<FormValues>(EMPTY);
  const [oauthResource, setOAuthResource] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const publicOAuth = allowPublicOAuthResource && values.header.trim() === '' && values.value.trim() === '';
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
    setLink(null);
    const begin = (): Promise<AddedConnector> => create({ ...trimmed(values), ...(publicOAuth && oauthResource.trim() !== '' ? { oauthResource: oauthResource.trim() } : {}) });
    const request = publicOAuth ? inNewTab(begin, (result) => result.authorizeUrl, setLink) : begin();
    request
      .then((result) => {
        if (result.authorizeUrl !== null) {
          if (!publicOAuth) goExternal(result.authorizeUrl);
          return;
        }
        onAdded(result.id);
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
      <Text size="md" role="secondary">{hint}</Text>
      <Col gap={10}>
        <Fields specs={FIELDS} values={values} busy={busy} onChange={change} onSubmit={submit} />
      </Col>
      <Advanced fields={{ specs: [], values, busy, onChange: change, onSubmit: submit }} callbackUrl={callbackUrl} publicOAuth={publicOAuth} oauth={{ value: oauthResource, onChange: setOAuthResource }} />
      {link === null ? null : <TextLink url={link}>Open sign-in</TextLink>}
      {error !== null ? <Text size="md" role="danger">{error}</Text> : null}
      <Row justify="between" align="center" gap={12} wrap>
        <Button
          color="secondary"
          dark={dark}
          onPress={onCancel}
          disabled={busy}
          label="Cancel"
        />
        <Button size="lg"
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

interface ConnectorModalProps {
  title: string;
  hint: string;
  callbackUrl: string | null;
  create: (values: NewOrgConnector) => Promise<AddedConnector>;
  allowPublicOAuthResource?: boolean;
  open: boolean;
  onClose: () => void;
  onAdded: (id: string) => void;
}

export function ConnectorModal({ title, hint, callbackUrl, allowPublicOAuthResource, create, open, onClose, onAdded }: ConnectorModalProps): ReactNode {
  return (
    <Modal title={title} open={open} onClose={onClose}>
      <ConnectorForm
        hint={hint}
        callbackUrl={callbackUrl}
        allowPublicOAuthResource={allowPublicOAuthResource}
        create={create}
        onCancel={onClose}
        onAdded={(id) => {
          onClose();
          onAdded(id);
        }}
      />
    </Modal>
  );
}
