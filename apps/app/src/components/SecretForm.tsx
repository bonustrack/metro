import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { FormField } from './FormField.js';
import { Text } from '@stage-labs/kit/react-native/text';
import { changeVault, envNameOf, hostsOf, type Vault, type VaultSecret } from '@metro-labs/client/api/vault';
import { queryError } from '../lib/queries.js';

interface SecretFormProps {
  editing: VaultSecret | null;
  onSaved: (vault: Vault) => void;
  onCancel: () => void;
}

interface Draft {
  name: string;
  env: string;
  hosts: string;
  value: string;
}

const draftOf = (editing: VaultSecret | null): Draft =>
  editing === null ? { name: '', env: '', hosts: '', value: '' } : { name: editing.name, env: editing.env, hosts: editing.hosts.join(', '), value: '' };

function bodyOf(editing: VaultSecret | null, d: Draft, variable: string): Record<string, unknown> {
  if (editing === null) return { action: 'add', name: d.name, env: variable, hosts: hostsOf(d.hosts), value: d.value };
  return { action: 'update', id: editing.id, name: d.name, hosts: hostsOf(d.hosts), ...(d.value === '' ? {} : { value: d.value }) };
}

const complete = (editing: VaultSecret | null, d: Draft): boolean =>
  d.name.trim() !== '' && d.hosts.trim() !== '' && (editing !== null || d.value !== '');

export function SecretForm({ editing, onSaved, onCancel }: SecretFormProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [draft, setDraft] = useState(() => draftOf(editing));
  const { name, env, hosts, value } = draft;
  const edit = (key: keyof Draft) => (next: string): void => {
    setDraft((d) => ({ ...d, [key]: next }));
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const variable = env === '' ? envNameOf(name) : env;
  const save = (): void => {
    setBusy(true);
    setError(null);
    changeVault(bodyOf(editing, draft, variable))
      .then(onSaved)
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not save the secret.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Col gap={12}>
      <Text size="md" weight="semibold">{editing === null ? 'Add a secret' : `Edit ${editing.name}`}</Text>
      <FormField label="Name" name="secret-name" value={name} placeholder="OpenAI" disabled={busy} dark={dark} onChangeText={edit('name')} />
      {editing === null ? (
        <FormField label="Variable the agent sees" name="secret-env" value={variable} placeholder="OPENAI_API_KEY" disabled={busy} dark={dark} onChangeText={edit('env')} />
      ) : null}
      <FormField label="Websites it may be sent to" name="secret-hosts" value={hosts} placeholder="api.openai.com, *.openai.com" disabled={busy} dark={dark} onChangeText={edit('hosts')} />
      <FormField
        label={editing === null ? 'Value' : 'New value (leave empty to keep the current one)'}
        name="secret-value"
        value={value}
        placeholder="sk-…"
        inputType="password"
        disabled={busy}
        dark={dark}
        onChangeText={edit('value')}
      />
      <Row gap={8}>
        <Button size="lg" dark={dark} disabled={busy || !complete(editing, draft)} label={busy ? 'Saving…' : 'Save'} onPress={save} />
        <Button size="md" color="secondary" dark={dark} disabled={busy} label="Cancel" onPress={onCancel} />
      </Row>
      {error === null ? null : <Text size="2xs" role="danger">{error}</Text>}
    </Col>
  );
}
