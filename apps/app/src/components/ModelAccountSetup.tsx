import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { FormField } from './FormField.js';
import { ClaudeConnect } from './ClaudeConnect.js';
import { CodexConnect } from './CodexConnect.js';
import { OpenRouterConnect } from './OpenRouterConnect.js';
import { ProviderChoices } from './ProviderChoices.js';
import { TextLink } from './TextLink.js';
import { Actions } from './ui/Actions.js';
import { ErrorState } from './ui/ErrorState.js';
import { FocusFrame, FocusIntro, type FocusStep } from './ui/FocusFrame.js';
import { Rows } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { StateBlock } from './ui/StateBlock.js';
import { ANTHROPIC_KEYS_URL, OPENROUTER_KEYS_URL, PROVIDERS, usesKey, type ConnectionRow, type Provider } from '@metro-labs/client/api/model';
import { addOrgModel, updateOrgModel } from '@metro-labs/client/api/org-models';
import { connectionPatch, type KeyDraft } from './model-view.js';
import { providerInfo, providerLabel } from '@metro-labs/client/api/providers';
import { queryError } from '../lib/queries.js';
import { afterModelChange, useOrgModelsQuery } from '../lib/model-queries.js';
import { signInTitle } from '../lib/model-words.js';
import { go } from '../lib/nav.js';
import { GROW } from '../lib/style.js';

const ZDR_NOTE = 'Only OpenRouter providers that keep no prompts. A model with no such provider stops answering.';
const MEMBER_NOTE = 'Only an admin of the organization can change the accounts.';
const STEPS: FocusStep[] = [
  { id: 'provider', label: 'Provider' },
  { id: 'connect', label: 'Connect' },
];

function KeyHelp({ provider }: { provider: Provider }): ReactNode {
  if (provider === 'openrouter') return <TextLink size="xs" url={OPENROUTER_KEYS_URL}>Get a key from OpenRouter</TextLink>;
  if (provider === 'anthropic') return <TextLink size="xs" url={ANTHROPIC_KEYS_URL}>Get a key from the Anthropic Console</TextLink>;
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
  const [draft, setDraft] = useState<KeyDraft>(() => draftOf(row));
  const { busy, error, save } = useSaveDraft(provider, row, onDone);
  const missingKey = row === null && withKey && draft.key.trim() === '';
  return (
    <Col gap={16}>
      <KeyFields provider={provider} stored={keyStored(row)} withKey={withKey} draft={draft} setDraft={setDraft} />
      <Actions error={error} main={{ label: busy ? 'Saving…' : 'Save', busy, disabled: missingKey, onPress: () => { save(draft); } }} />
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
    <Rows>
      <Item title="Zero data retention" subtitle={error ?? ZDR_NOTE} subtitleTone={error === null ? 'secondary' : 'danger'} trailing={<Switch name="Zero data retention" checked={on} dark={dark} onChange={change} />} />
    </Rows>
  );
}

function Body({ provider, row, onDone }: { provider: Provider; row: ConnectionRow | null; onDone: () => void }): ReactNode {
  if (provider === 'codex')
    return (
      <Col gap={32}>
        {row === null ? null : <ConnectionForm provider={provider} row={row} withKey={false} onDone={onDone} />}
        <CodexConnect codex={row} onDone={onDone} />
      </Col>
    );
  if (provider === 'anthropic' && row?.subscription === true)
    return (
      <Col gap={32}>
        <ConnectionForm provider={provider} row={row} withKey={false} onDone={onDone} />
        <ClaudeConnect connection={row} onDone={onDone} />
      </Col>
    );
  const form = <ConnectionForm provider={provider} row={row} withKey={usesKey(provider)} onDone={onDone} />;
  if (provider === 'anthropic' && row === null) return <ClaudeConnect connection={null} onDone={onDone}>{form}</ClaudeConnect>;
  if (provider !== 'openrouter') return form;
  return (
    <Col gap={32}>
      {row === null ? null : <ZdrSwitch row={row} />}
      <OpenRouterConnect connection={row} onDone={onDone}>{form}</OpenRouterConnect>
    </Col>
  );
}

const knownProvider = (raw: string | undefined): Provider | null => PROVIDERS.find((p) => p.id === raw)?.id ?? null;

function Gate({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): ReactNode {
  const { data, error, refetch } = useOrgModelsQuery();
  if (data !== undefined && data.admin) return children;
  return (
    <FocusFrame title={title} onClose={onClose}>
      {error !== null ? (
        <ErrorState title="Could not load the models" text={queryError(error, 'Metro did not answer.')} onRetry={refetch} />
      ) : data === undefined ? (
        <RowsSkeleton rows={4} />
      ) : (
        <StateBlock icon="sparkle" title="Admins only" text={MEMBER_NOTE} action={{ label: 'Back to Models', onPress: onClose }} />
      )}
    </FocusFrame>
  );
}

export function AddModelAccountPage({ provider: raw }: { provider?: string }): ReactNode {
  const provider = knownProvider(raw);
  const close = (): void => {
    go({ kind: 'org-models' });
  };
  return (
    <Gate title="Add a model account" onClose={close}>
      <FocusFrame title="Add a model account" onClose={close} steps={STEPS} step={provider === null ? 'provider' : 'connect'} onStep={() => { go({ kind: 'org-model-add' }); }}>
          {provider === null ? (
            <>
              <FocusIntro title="Where do the models come from?" text="Pick a provider. Every agent of the organization can use the account." />
              <ProviderChoices />
            </>
          ) : (
            <>
              <FocusIntro title={providerLabel(provider)} text={providerInfo(provider)?.blurb} />
              <Body provider={provider} row={null} onDone={close} />
            </>
          )}
      </FocusFrame>
    </Gate>
  );
}

function SignIn({ id, onClose }: { id: string; onClose: () => void }): ReactNode {
  const { data } = useOrgModelsQuery();
  const connection = data?.connections.find((c) => c.id === id);
  if (connection === undefined)
    return (
      <FocusFrame title="Model account" onClose={onClose}>
        <StateBlock icon="sparkle" title="This account is gone" text="It is not in this organization any more." action={{ label: 'Back to Models', onPress: () => { go({ kind: 'org-models' }); } }} />
      </FocusFrame>
    );
  const sign = signInTitle(connection);
  return (
    <FocusFrame title={connection.label === '' ? providerLabel(connection.provider) : connection.label} onClose={onClose}>
      <FocusIntro title={sign.title} text={sign.subtitle} />
      <Body key={connection.id} provider={connection.provider} row={connection} onDone={onClose} />
    </FocusFrame>
  );
}

export function ModelSignInPage({ id }: { id: string }): ReactNode {
  const close = (): void => {
    go({ kind: 'org-model', id });
  };
  return (
    <Gate title="Model account" onClose={close}>
      <SignIn id={id} onClose={close} />
    </Gate>
  );
}
