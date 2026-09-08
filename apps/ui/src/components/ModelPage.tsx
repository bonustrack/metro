import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui';
import { PageTitle } from './PageTitle';
import { FieldLabel } from './FieldLabel';
import { Loading } from './Loading';
import { GROW } from '../theme';
import { afterSave, draftOf, OPENROUTER_KEYS_URL, patchOf, PROVIDERS, routeLabel, saveModel, type Draft, type ModelSettings } from '../api/model';
import { queryError, refreshModel, useCodexModelsQuery, useModelQuery, useOpenRouterModelsQuery } from '../api/queries';
import { ModelPicker } from './ModelPicker';
import { useDocumentTitle } from '../title';
import { CodexConnect } from './CodexConnect';

const HOW =
  'Claude Code sessions started with metro claude send every request through this daemon, which forwards it to the provider chosen here. A change applies to the next request, no restart needed. Inside a session, /model bedrock:<id>, /model openrouter:<id> or /model codex:<id> switches that session only.';
const FIELD_WIDTH = 420;

interface KeyFieldProps {
  label: string;
  hasKey: boolean;
  value: string;
  forget: boolean;
  onChange: (value: string) => void;
  onForget: (forget: boolean) => void;
}

function KeyField({ label, hasKey, value, forget, onChange, onForget }: KeyFieldProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={4} maxWidth={FIELD_WIDTH}>
      <FieldLabel>{label}</FieldLabel>
      <Input name={label} inputType="password" value={value} placeholder={hasKey ? 'stored on the daemon, paste to replace' : 'paste the key'} dark={dark} onChangeText={onChange} disabled={forget} style={GROW} inputProps={{ autoComplete: 'off' }} />
      {hasKey && value === '' ? (
        <Row gap={8} align="center" wrap>
          <Button size="sm" color="secondary" dark={dark} label={forget ? 'Keep the stored key' : 'Forget the stored key'} onPress={() => { onForget(!forget); }} />
          {forget ? <Text size="sm" role="secondary">Removed when you save.</Text> : null}
        </Row>
      ) : null}
    </Col>
  );
}

function OpenRouterFields({ draft, settings, set }: { draft: Draft; settings: ModelSettings; set: (next: Partial<Draft>) => void }): ReactNode {
  const [wanted, setWanted] = useState(false);
  const models = useOpenRouterModelsQuery(wanted);
  return (
    <Col gap={12}>
      <KeyField
        label="OpenRouter API key"
        hasKey={settings.openrouter.hasKey}
        value={draft.openrouterKey}
        forget={draft.openrouterForget}
        onChange={(v) => {
          set({ openrouterKey: v });
        }}
        onForget={(f) => {
          set({ openrouterForget: f });
        }}
      />
      <Text size="sm" role="secondary">
        <a className="hint-link" href={OPENROUTER_KEYS_URL} target="_blank" rel="noreferrer">
          Get a key from OpenRouter
        </a>
      </Text>
      <ModelPicker
        label="Model"
        value={draft.openrouterModel}
        placeholder="type to search, e.g. sonnet, gpt-5, gemini"
        models={models.data}
        loading={models.isFetching}
        error={models.error === null ? null : queryError(models.error, 'Could not list the OpenRouter models.')}
        onOpen={() => {
          setWanted(true);
        }}
        onChange={(v) => {
          set({ openrouterModel: v });
        }}
      />
    </Col>
  );
}

function CodexFields({ draft, settings, set }: { draft: Draft; settings: ModelSettings; set: (next: Partial<Draft>) => void }): ReactNode {
  const [wanted, setWanted] = useState(false);
  const models = useCodexModelsQuery(wanted && settings.codex.signedIn);
  return (
    <Col gap={12}>
      <CodexConnect codex={settings.codex} />
      <ModelPicker
        label="Model"
        value={draft.codexModel}
        placeholder="type to search, e.g. astra, codex, gpt-5"
        models={models.data}
        loading={models.isFetching}
        error={models.error === null ? null : queryError(models.error, 'Could not list the models this account can use.')}
        onOpen={() => {
          setWanted(true);
        }}
        onChange={(v) => {
          set({ codexModel: v });
        }}
      />
    </Col>
  );
}

function TextField({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (v: string) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={4} maxWidth={FIELD_WIDTH}>
      <FieldLabel>{label}</FieldLabel>
      <Input name={label} value={value} placeholder={placeholder} dark={dark} onChangeText={onChange} style={GROW} />
    </Col>
  );
}

function ProviderFields({ draft, settings, set }: { draft: Draft; settings: ModelSettings; set: (next: Partial<Draft>) => void }): ReactNode {
  if (draft.provider === 'bedrock')
    return (
      <Col gap={12}>
        <KeyField label="Bedrock API key" hasKey={settings.bedrock.hasKey} value={draft.bedrockKey} forget={draft.bedrockForget} onChange={(v) => { set({ bedrockKey: v }); }} onForget={(f) => { set({ bedrockForget: f }); }} />
        <TextField label="Region" value={draft.bedrockRegion} placeholder="eu-central-1" onChange={(v) => { set({ bedrockRegion: v }); }} />
        <TextField label="Model" value={draft.bedrockModel} placeholder="empty: the model Claude Code asks for, e.g. eu.anthropic.claude-sonnet-4-6" onChange={(v) => { set({ bedrockModel: v }); }} />
      </Col>
    );
  if (draft.provider === 'openrouter') return <OpenRouterFields draft={draft} settings={settings} set={set} />;
  if (draft.provider === 'codex') return <CodexFields draft={draft} settings={settings} set={set} />;
  return (
    <Text size="sm" role="secondary">
      Requests go to api.anthropic.com exactly as Claude Code sent them, with its own login. Nothing to configure.
    </Text>
  );
}

function Editor({ settings }: { settings: ModelSettings }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (next: Partial<Draft>): void => {
    setDraft((d) => ({ ...d, ...next }));
    setNote(null);
  };
  const save = (): void => {
    setBusy(true);
    setError(null);
    saveModel(patchOf(draft))
      .then(async () => {
        setDraft(afterSave);
        await refreshModel(client);
        setNote('Saved. The next request from a running session takes this route.');
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not save the model settings.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const unsaved = draft.provider !== settings.provider;
  return (
    <Col gap={20}>
      <Row gap={8} wrap>
        {PROVIDERS.map((p) => (
          <Button key={p.id} size="sm" dark={dark} color={p.id === draft.provider ? 'primary' : 'secondary'} label={p.label} onPress={() => { set({ provider: p.id }); }} />
        ))}
      </Row>
      <Text size="sm" role="secondary">
        {PROVIDERS.find((p) => p.id === draft.provider)?.blurb ?? ''}
      </Text>
      <ProviderFields draft={draft} settings={settings} set={set} />
      <Row gap={12} align="center" wrap>
        <Button dark={dark} label={busy ? 'Saving…' : 'Save'} loading={busy} disabled={busy} onPress={save} />
        {unsaved ? <Text size="sm" role="secondary">Not in use until you save.</Text> : null}
        {note !== null ? <Text size="sm" role="secondary">{note}</Text> : null}
        {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
      </Row>
    </Col>
  );
}

export function ModelPage(): ReactNode {
  const model = useModelQuery();
  useDocumentTitle('Model');
  return (
    <Col gap={20}>
      <Col gap={8}>
        <PageTitle>Model</PageTitle>
        <Text size="sm" role="secondary">
          {HOW}
        </Text>
      </Col>
      {model.error !== null ? (
        <Text size="sm" role="danger">
          {queryError(model.error, 'Could not read the model settings.')}
        </Text>
      ) : model.data === undefined ? (
        <Loading />
      ) : (
        <Col gap={20}>
          <Col gap={2}>
            <FieldLabel>In use</FieldLabel>
            <Text size="sm">{routeLabel(model.data)}</Text>
            {model.data.reason !== null ? (
              <Text size="sm" role="danger">
                {model.data.reason}
              </Text>
            ) : null}
          </Col>
          <Editor settings={model.data} />
        </Col>
      )}
    </Col>
  );
}
