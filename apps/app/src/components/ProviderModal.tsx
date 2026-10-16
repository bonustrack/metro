import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { Text } from '@stage-labs/kit/react-native/text';
import { FormField } from './FormField.js';
import { Modal } from './Modal.js';
import { Icon } from './Icon.js';
import { ClaudeConnect } from './ClaudeConnect.js';
import { CodexConnect } from './CodexConnect.js';
import { OpenRouterConnect } from './OpenRouterConnect.js';
import { ProviderChoices } from './ProviderChoices.js';
import { TextLink } from './TextLink.js';
import { ANTHROPIC_KEYS_URL, OPENROUTER_KEYS_URL, usesKey, type ConnectionRow, type Provider } from '@metro-labs/client/api/model';
import { addOrgModel, updateOrgModel } from '@metro-labs/client/api/org-models';
import { connectionPatch, type KeyDraft } from './model-view.js';
import { providerInfo, providerLabel } from '@metro-labs/client/api/providers';
import { queryError } from '../lib/queries.js';
import { afterModelChange } from '../lib/model-queries.js';
import { GROW } from '../lib/style.js';

const ZDR_NOTE = 'Only OpenRouter providers that keep no prompts. A model with no such provider stops answering.';

export interface Editing {
  provider: Provider | null;
  connection: ConnectionRow | null;
}

function KeyHelp({ provider }: { provider: Provider }): ReactNode {
  if (provider === 'openrouter') return <TextLink size="md" url={OPENROUTER_KEYS_URL}>Get a key from OpenRouter</TextLink>;
  if (provider === 'anthropic') return <TextLink size="md" url={ANTHROPIC_KEYS_URL}>Get a key from the Anthropic Console</TextLink>;
  return null;
}

function useSaveDraft(provider: Provider, row: ConnectionRow | null, onDone: () => void): { busy: boolean; error: string | null; save: (draft: KeyDraft) => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (draft: KeyDraft): void => {
    setBusy(true);
    setError(null);
    const label = draft.label.trim() === '' ? providerLabel(provider) : draft.label.trim();
    const job = row === null
      ? addOrgModel({ provider, label, apiKey: draft.key, ...(provider === 'bedrock' ? { region: draft.region.trim() } : {}) })
      : updateOrgModel(row.id, connectionPatch(provider, draft, row));
    job
      .then(() => afterModelChange(client))
      .then(onDone)
      .catch((err: unknown) => { setError(queryError(err, 'Could not save.')); })
      .finally(() => { setBusy(false); });
  };
  return { busy, error, save };
}

interface FieldsProps {
  provider: Provider;
  stored: boolean;
  withKey: boolean;
  draft: KeyDraft;
  setDraft: (next: (d: KeyDraft) => KeyDraft) => void;
}

function KeyFields({ provider, stored, withKey, draft, setDraft }: FieldsProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <>
      <FormField label="Name" name="label" value={draft.label} placeholder={providerLabel(provider)} dark={dark} onChangeText={(label) => { setDraft((d) => ({ ...d, label })); }} style={GROW} />
      {withKey ? (
        <FormField label="API key" name="api-key" inputType="password" value={draft.key} placeholder={stored ? 'Stored for the organization. Paste a new key to replace it.' : 'Paste the key'} dark={dark} onChangeText={(key) => { setDraft((d) => ({ ...d, key })); }} style={GROW} inputProps={{ autoComplete: 'off' }} />
      ) : null}
      {provider === 'bedrock' ? <FormField label="Region" name="region" value={draft.region} placeholder="eu-central-1" dark={dark} onChangeText={(region) => { setDraft((d) => ({ ...d, region })); }} style={GROW} /> : null}
      {withKey ? <KeyHelp provider={provider} /> : null}
    </>
  );
}

const draftOf = (row: ConnectionRow | null): KeyDraft => ({ label: row?.label ?? '', key: '', region: row?.region ?? '' });
const keyStored = (row: ConnectionRow | null): boolean => row !== null && !row.signedOut;

function ConnectionForm({ provider, row, withKey, onDone }: { provider: Provider; row: ConnectionRow | null; withKey: boolean; onDone: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [draft, setDraft] = useState<KeyDraft>(() => draftOf(row));
  const { busy, error, save } = useSaveDraft(provider, row, onDone);
  const missingKey = row === null && withKey && draft.key.trim() === '';
  return (
    <Col gap={12}>
      <KeyFields provider={provider} stored={keyStored(row)} withKey={withKey} draft={draft} setDraft={setDraft} />
      <Row gap={12} align="center" wrap>
        <Button size="lg" dark={dark} label={busy ? 'Saving…' : 'Save'} loading={busy} disabled={busy || missingKey} onPress={() => { save(draft); }} />
        {error === null ? null : <Text size="md" role="danger">{error}</Text>}
      </Row>
    </Col>
  );
}

function ZdrSwitch({ row }: { row: ConnectionRow }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const [on, setOn] = useState(row.zdr);
  const [error, setError] = useState<string | null>(null);
  const change = (zdr: boolean): void => {
    setError(null);
    setOn(zdr);
    updateOrgModel(row.id, { zdr })
      .then(() => afterModelChange(client))
      .catch((err: unknown) => {
        setOn(!zdr);
        setError(queryError(err, 'Could not change zero data retention.'));
      });
  };
  return (
    <Col gap={6} padding={12} radius={10} surface="raised">
      <Row align="center" gap={12}>
        <Icon name="shieldCheck" size={18} color={useKitPalette().link} />
        <Col flex={1} minWidth={0} gap={2}>
          <Text size="xs" weight="medium">Zero data retention</Text>
          <Text size="md" role="secondary">{ZDR_NOTE}</Text>
        </Col>
        <Switch name="Zero data retention" checked={on} dark={dark} onChange={change} />
      </Row>
      {error === null ? null : <Text size="md" role="danger">{error}</Text>}
    </Col>
  );
}

function Body({ provider, row, onDone }: { provider: Provider; row: ConnectionRow | null; onDone: () => void }): ReactNode {
  if (provider === 'codex')
    return (
      <Col gap={20}>
        {row === null ? null : <ConnectionForm provider={provider} row={row} withKey={false} onDone={onDone} />}
        <CodexConnect codex={row} onDone={onDone} />
      </Col>
    );
  if (provider === 'anthropic' && row?.subscription === true)
    return (
      <Col gap={20}>
        <ConnectionForm provider={provider} row={row} withKey={false} onDone={onDone} />
        <ClaudeConnect connection={row} onDone={onDone} />
      </Col>
    );
  const form = <ConnectionForm provider={provider} row={row} withKey={usesKey(provider)} onDone={onDone} />;
  if (provider === 'anthropic' && row === null) return <ClaudeConnect connection={null} onDone={onDone}>{form}</ClaudeConnect>;
  if (provider !== 'openrouter') return form;
  return (
    <Col gap={20}>
      {row === null ? null : <ZdrSwitch row={row} />}
      <OpenRouterConnect connection={row} onDone={onDone}>{form}</OpenRouterConnect>
    </Col>
  );
}

function AddFlow({ onDone }: { onDone: () => void }): ReactNode {
  const [provider, setProvider] = useState<Provider | null>(null);
  if (provider === null) return <ProviderChoices onPick={setProvider} />;
  return (
    <Col gap={16}>
      <Text size="xs" weight="medium">{providerLabel(provider)}</Text>
      <Text size="md" role="secondary">{providerInfo(provider)?.blurb ?? ''}</Text>
      <Body provider={provider} row={null} onDone={onDone} />
      <Row>
        <TextLink size="md" onPress={() => { setProvider(null); }}>Choose another provider</TextLink>
      </Row>
    </Col>
  );
}

export function ProviderModal({ editing, onClose }: { editing: Editing | null; onClose: () => void }): ReactNode {
  if (editing === null) return null;
  const { provider, connection } = editing;
  if (provider === null || connection === null)
    return (
      <Modal title="Add an account" open onClose={onClose}>
        <AddFlow onDone={onClose} />
      </Modal>
    );
  return (
    <Modal title={connection.label === '' ? providerLabel(provider) : connection.label} open onClose={onClose}>
      <Col gap={16}>
        <Text size="md" role="secondary">{providerInfo(provider)?.blurb ?? ''}</Text>
        <Body key={connection.id} provider={provider} row={connection} onDone={onClose} />
      </Col>
    </Modal>
  );
}
