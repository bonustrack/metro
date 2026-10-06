import { type ReactNode, useRef, useState } from 'react';
import { ConnectionModel } from './ConnectionModel.js';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { FormField } from './FormField.js';
import { Text } from '@stage-labs/kit/react-native/text';
import { Modal } from './Modal.js';
import { CodexConnect } from './CodexConnect.js';
import { GeminiConnect } from './GeminiConnect.js';
import { OpenRouterConnect } from './OpenRouterConnect.js';
import { daemonBase } from '@metro-labs/client/auth/daemon';
import { ClaudeLoginCard } from './ClaudeLogin.js';
import { addConnection, ANTHROPIC_KEYS_URL, OPENROUTER_KEYS_URL, PROVIDERS, saveConnection, type ConnectionPatch, type ConnectionRow, type Provider } from '@metro-labs/client/api/model';
import { providerLabel } from '@metro-labs/client/api/providers';
import type { RouteDraft } from '@metro-labs/client/api/route-edit';
import { queryError, refresh, useModelQuery } from '../lib/queries.js';
import { GROW } from '../lib/style.js';
import { TextLink } from './TextLink.js';
import { ProviderChoices } from './ProviderChoices.js';

const ANTHROPIC_KEY_NOTE = 'No key: it uses the Claude sign-in above, or else the Claude Code login of this machine.';

export interface Editing {
  provider: Provider | null;
  connection: ConnectionRow | null;
}

interface Chosen {
  provider: Provider;
  connection: ConnectionRow | null;
}

function KeyLink({ url, label }: { url: string; label: string }): ReactNode {
  return (
    <TextLink size="2xs" url={url}>{label}</TextLink>
  );
}

interface Draft {
  label: string;
  key: string;
  region: string;
}

const draftOf = (row: ConnectionRow | null): Draft => ({ label: row?.label ?? '', key: '', region: row?.region ?? '' });

function patchOf(provider: Provider, draft: Draft): ConnectionPatch {
  const key = draft.key.trim() === '' ? {} : { apiKey: draft.key.trim() };
  const label = draft.label.trim() === '' ? {} : { label: draft.label.trim() };
  if (provider === 'bedrock') return { ...key, ...label, region: draft.region.trim() };
  return { ...key, ...label };
}

function Extras({ provider, draft, setDraft }: { provider: Provider; draft: Draft; setDraft: (next: (d: Draft) => Draft) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  if (provider === 'openrouter') return <KeyLink url={OPENROUTER_KEYS_URL} label="Get a key from OpenRouter" />;
  if (provider === 'anthropic')
    return (
      <Col gap={6}>
        <KeyLink url={ANTHROPIC_KEYS_URL} label="Get a key from the Anthropic Console" />
        <Text size="2xs" role="secondary">{ANTHROPIC_KEY_NOTE}</Text>
      </Col>
    );
  if (provider === 'bedrock')
    return (
      <Col gap={4}>
        <FormField label="Region" name="region" value={draft.region} placeholder="eu-central-1" dark={dark} onChangeText={(region) => { setDraft((d) => ({ ...d, region })); }} style={GROW} />
      </Col>
    );
  return null;
}

function KeyForm({ editing, onDone }: { editing: Chosen; onDone: () => void }): ReactNode {
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
      .then(() => refresh(client, 'model'))
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
        <FormField label="Name" name="label" value={draft.label} placeholder={providerLabel(editing.provider)} dark={dark} onChangeText={(label) => { setDraft((d) => ({ ...d, label })); }} style={GROW} />
      </Col>
      <Col gap={4}>
        <FormField label="API key" name="api-key" inputType="password" value={draft.key} placeholder={row?.hasKey === true ? 'stored on the daemon, paste to replace' : 'paste the key'} dark={dark} onChangeText={(key) => { setDraft((d) => ({ ...d, key })); }} style={GROW} inputProps={{ autoComplete: 'off' }} />
      </Col>
      <Extras provider={editing.provider} draft={draft} setDraft={setDraft} />
      <Row gap={12} align="center" wrap>
        <Button size="lg" dark={dark} label={busy ? 'Saving…' : 'Save'} loading={busy} disabled={busy} onPress={save} />
        {error === null ? null : <Text size="2xs" role="danger">{error}</Text>}
      </Row>
    </Col>
  );
}

function OpenRouterForm({ editing, onDone }: { editing: Chosen; onDone: () => void }): ReactNode {
  const connection = editing.connection?.id ?? '';
  return (
    <OpenRouterConnect key={`${daemonBase()}:${connection}`} connection={connection} onDone={onDone}>
      <KeyForm editing={editing} onDone={onDone} />
    </OpenRouterConnect>
  );
}

function Body({ editing, onDone }: { editing: Chosen; onDone: () => void }): ReactNode {
  const client = useQueryClient();
  if (editing.provider === 'codex') return <CodexConnect codex={editing.connection} />;
  if (editing.provider === 'gemini') return <GeminiConnect gemini={editing.connection} />;
  if (editing.provider === 'openrouter') return <OpenRouterForm editing={editing} onDone={onDone} />;
  if (editing.provider === 'anthropic' && editing.connection?.hasKey !== true)
    return (
      <Col gap={20}>
        <ClaudeLoginCard
          connection={editing.connection}
          onDone={() => {
            refresh(client, 'model').then(onDone, () => undefined);
          }}
        />
        <KeyForm editing={editing} onDone={onDone} />
      </Col>
    );
  return <KeyForm editing={editing} onDone={onDone} />;
}

function Blurb({ editing }: { editing: Chosen }): ReactNode {
  const info = PROVIDERS.find((p) => p.id === editing.provider);
  return (
    <>
      <Text size="2xs" role="secondary">{info?.blurb ?? ''}</Text>
      {editing.connection?.signedIn !== true ? null : (
        <Text size="2xs" role="secondary">Signing in again replaces this connection&apos;s credential.</Text>
      )}
    </>
  );
}

export function ProviderSetup({ onDone, onBack }: { onDone: (draft: RouteDraft) => void; onBack?: () => void }): ReactNode {
  const settings = useModelQuery().data;
  const known = useRef(settings?.connections.map((c) => c.id) ?? []);
  const [provider, setProvider] = useState<Provider | null>(null);
  const fresh = settings?.connections.find((c) => c.provider === provider && !known.current.includes(c.id));
  const back = provider === null ? onBack : () => { setProvider(null); };
  if (fresh !== undefined && settings !== undefined) return <ConnectionModel conn={fresh} settings={settings} onDone={onDone} />;
  return (
    <Col gap={16}>
      {provider === null ? <ProviderChoices onPick={setProvider} /> : (
        <Col gap={16}>
          <Text size="xs" weight="medium">{providerLabel(provider)}</Text>
          <Blurb editing={{ provider, connection: null }} />
          <Body editing={{ provider, connection: null }} onDone={() => undefined} />
        </Col>
      )}
      {back === undefined ? null : (
        <Row>
          <TextLink size="2xs" onPress={back}>{provider === null ? 'Back to connections' : 'Choose another provider'}</TextLink>
        </Row>
      )}
    </Col>
  );
}

export function ProviderModal({ editing, onClose }: { editing: Editing | null; onClose: () => void }): ReactNode {
  const settings = useModelQuery().data;
  if (editing === null) return null;
  const { provider, connection } = editing;
  if (provider === null)
    return (
      <Modal title="Add a connection" open onClose={onClose}>
        <ProviderSetup onDone={onClose} />
      </Modal>
    );
  const title = connection?.label ?? `Connect ${providerLabel(provider)}`;
  return (
    <Modal title={title} open onClose={onClose}>
      <Col gap={16}>
        {connection === null || settings === undefined ? null : <ConnectionModel key={connection.id} conn={connection} settings={settings} onDone={onClose} />}
        <Blurb editing={{ provider, connection }} />
        <Body editing={{ provider, connection }} onDone={onClose} />
      </Col>
    </Modal>
  );
}
