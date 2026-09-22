import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { FieldLabel } from './FieldLabel.js';
import { Modal } from './Modal.js';
import { CodexConnect } from './CodexConnect.js';
import { GeminiConnect } from './GeminiConnect.js';
import { ClaudeLoginCard } from './ClaudeLogin.js';
import { addConnection, ANTHROPIC_KEYS_URL, OPENROUTER_KEYS_URL, PROVIDERS, saveConnection, type ConnectionPatch, type ConnectionRow, type Provider } from '../api/model.js';
import { providerLabel, usesKey } from '../api/providers.js';
import { queryError, refreshModel } from '../api/queries.js';
import { GROW } from '../theme.js';

const ZDR_NOTE = 'Only reaches providers that keep no prompts. A model without such an endpoint fails rather than falling back.';
const ANTHROPIC_KEY_NOTE = 'No key: the request carries the session’s own Claude Code login.';

export interface Editing {
  provider: Provider;
  connection: ConnectionRow | null;
}

function KeyLink({ url, label }: { url: string; label: string }): ReactNode {
  return (
    <Text size="sm" role="secondary">
      <a className="hint-link" href={url} target="_blank" rel="noreferrer">
        {label}
      </a>
    </Text>
  );
}

interface Draft {
  label: string;
  key: string;
  region: string;
  zdr: boolean;
}

const draftOf = (row: ConnectionRow | null): Draft => ({ label: row?.label ?? '', key: '', region: row?.region ?? '', zdr: row?.zdr === true });

function patchOf(provider: Provider, draft: Draft): ConnectionPatch {
  const key = draft.key.trim() === '' ? {} : { apiKey: draft.key.trim() };
  const label = draft.label.trim() === '' ? {} : { label: draft.label.trim() };
  if (provider === 'bedrock') return { ...key, ...label, region: draft.region.trim() };
  if (provider === 'openrouter') return { ...key, ...label, zdr: draft.zdr };
  return { ...key, ...label };
}

function Extras({ provider, draft, setDraft }: { provider: Provider; draft: Draft; setDraft: (next: (d: Draft) => Draft) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  if (provider === 'anthropic')
    return (
      <Col gap={6}>
        <KeyLink url={ANTHROPIC_KEYS_URL} label="Get a key from the Anthropic Console" />
        <Text size="sm" role="secondary">{ANTHROPIC_KEY_NOTE}</Text>
      </Col>
    );
  if (provider === 'bedrock')
    return (
      <Col gap={4}>
        <FieldLabel>Region</FieldLabel>
        <Input name="region" value={draft.region} placeholder="eu-central-1" dark={dark} onChangeText={(region) => { setDraft((d) => ({ ...d, region })); }} style={GROW} />
      </Col>
    );
  return (
    <Col gap={6}>
      <KeyLink url={OPENROUTER_KEYS_URL} label="Get a key from OpenRouter" />
      <Button size="sm" color={draft.zdr ? 'primary' : 'secondary'} dark={dark} label={draft.zdr ? 'Zero data retention: on' : 'Zero data retention: off'} onPress={() => { setDraft((d) => ({ ...d, zdr: !d.zdr })); }} />
      <Text size="sm" role="secondary">{ZDR_NOTE}</Text>
    </Col>
  );
}

function KeyForm({ editing, onDone }: { editing: Editing; onDone: () => void }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const row = editing.connection;
  const [draft, setDraft] = useState<Draft>(() => draftOf(row));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (): void => {
    setBusy(true);
    setError(null);
    const patch = patchOf(editing.provider, draft);
    const job = row === null ? addConnection({ provider: editing.provider, ...patch }) : saveConnection(row.id, patch);
    job
      .then(() => refreshModel(client))
      .then(onDone)
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not save.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Col gap={12}>
      <Col gap={4}>
        <FieldLabel>Name</FieldLabel>
        <Input name="label" value={draft.label} placeholder={providerLabel(editing.provider)} dark={dark} onChangeText={(label) => { setDraft((d) => ({ ...d, label })); }} style={GROW} />
      </Col>
      <Col gap={4}>
        <FieldLabel>API key</FieldLabel>
        <Input name="api-key" inputType="password" value={draft.key} placeholder={row?.hasKey === true ? 'stored on the daemon, paste to replace' : 'paste the key'} dark={dark} onChangeText={(key) => { setDraft((d) => ({ ...d, key })); }} style={GROW} inputProps={{ autoComplete: 'off' }} />
      </Col>
      <Extras provider={editing.provider} draft={draft} setDraft={setDraft} />
      <Row gap={12} align="center" wrap>
        <Button dark={dark} label={busy ? 'Saving…' : 'Save'} loading={busy} disabled={busy} onPress={save} />
        {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
      </Row>
    </Col>
  );
}

function Body({ editing, onDone }: { editing: Editing; onDone: () => void }): ReactNode {
  const client = useQueryClient();
  if (editing.provider === 'codex') return <CodexConnect codex={editing.connection} />;
  if (editing.provider === 'gemini') return <GeminiConnect gemini={editing.connection} />;
  if (editing.provider === 'anthropic' && editing.connection === null)
    return (
      <Col gap={20}>
        <ClaudeLoginCard
          onChange={() => {
            refreshModel(client).catch(() => undefined);
          }}
        />
        <KeyForm editing={editing} onDone={onDone} />
      </Col>
    );
  return <KeyForm editing={editing} onDone={onDone} />;
}

export function ProviderModal({ editing, onClose }: { editing: Editing | null; onClose: () => void }): ReactNode {
  if (editing === null) return null;
  const info = PROVIDERS.find((p) => p.id === editing.provider);
  const title = editing.connection?.label ?? `Connect ${providerLabel(editing.provider)}`;
  return (
    <Modal title={title} open onClose={onClose}>
      <Col gap={16}>
        <Text size="sm" role="secondary">{info?.blurb ?? ''}</Text>
        {usesKey(editing.provider) || editing.connection === null ? null : (
          <Text size="sm" role="secondary">Signing in again replaces this connection&apos;s credential.</Text>
        )}
        <Body editing={editing} onDone={onClose} />
      </Col>
    </Modal>
  );
}
