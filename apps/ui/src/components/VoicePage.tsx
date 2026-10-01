import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { Choice } from './Choice.js';
import { Loading } from './Loading.js';
import { ModelPickerModal } from './ModelPickerModal.js';
import { PageTitle } from './PageTitle.js';
import { SaveField, useSave } from './SaveField.js';
import { EmptyCard, SettingsGroup, SettingsSection } from './SettingsSection.js';
import { queryError, useBoxQuery, useModeQuery, useModelQuery } from '../api/queries.js';
import { olderThan } from '../api/version.js';
import {
  ELEVENLABS_KEYS_URL,
  ELEVENLABS_VOICES_URL,
  fetchVoice,
  providerName,
  saveVoice,
  VOICE_SINCE,
  voiceModelLabel,
  type VoicePatch,
  type VoiceSettings,
} from '../api/voice.js';
import { useDocumentTitle } from '../title.js';

const INTRO =
  'Call your agent from Stage and talk to it live. Metro listens and speaks with ElevenLabs, and the agent answers with its own memory, skills and tools. It picks up calls from the people who can approve on its Stage channel, and posts call notes to the chat after you hang up.';
const PORTS_NOTE = 'The server needs inbound UDP ports 40000 to 40100 open for the call audio.';
const KEY_NOTE = 'Give the key Speech to Text and Text to Speech access. Create one in ElevenLabs:';
const VOICE_NOTE = 'Empty means Sarah, the default voice. Paste any voice ID from the ElevenLabs voice library:';
const MODEL_NOTE = 'The model that thinks during calls, through the connections on the Model page, at low effort for speed.';

type Set = (next: VoiceSettings) => void;

function useVoice(): { voice: VoiceSettings | undefined; error: unknown; set: Set } {
  const client = useQueryClient();
  const query = useBoxQuery('voice', fetchVoice);
  return {
    voice: query.data,
    error: query.error,
    set: (next) => {
      client.setQueriesData({ predicate: (q) => q.queryKey.includes('voice') }, next);
    },
  };
}

function Link({ href }: { href: string }): ReactNode {
  return (
    <a className="hint-link" href={href} target="_blank" rel="noreferrer">
      {href.replace(/^https:\/\//, '')}
    </a>
  );
}

function AnswerCalls({ voice, set }: { voice: VoiceSettings; set: Set }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flip = (enabled: boolean): void => {
    setBusy(true);
    setError(null);
    saveVoice({ enabled })
      .then(set)
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not change it.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const note = voice.hasKey ? PORTS_NOTE : 'Add an API key below first.';
  return (
    <SettingsSection title="Answer calls" note={note}>
      <Choice
        label="Answer calls"
        value={voice.enabled ? 'on' : 'off'}
        options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
        disabled={busy}
        onChange={(value) => {
          flip(value === 'on');
        }}
      />
      {error === null ? null : <Text size="md" role="danger">{error}</Text>}
    </SettingsSection>
  );
}

function saver(set: Set, after?: () => void): (patch: VoicePatch) => Promise<void> {
  return async (patch) => {
    set(await saveVoice(patch));
    after?.();
  };
}

function ApiKey({ voice, set }: { voice: VoiceSettings; set: Set }): ReactNode {
  const save = saver(set, () => {
    saving.setValue('');
  });
  const saving = useSave({ initial: '', valid: (v) => v !== '', run: (apiKey) => save({ apiKey }), failure: 'Could not save the key.' });
  return (
    <SettingsSection title={`${providerName(voice.provider)} API key`} note={KEY_NOTE}>
      <Link href={ELEVENLABS_KEYS_URL} />
      <SaveField saving={saving} name="voice-api-key" label="API key" placeholder={voice.hasKey ? 'stored on the daemon, paste to replace' : 'paste the key'} secret />
    </SettingsSection>
  );
}

function VoiceId({ voice, set }: { voice: VoiceSettings; set: Set }): ReactNode {
  const saving = useSave({ initial: voice.voiceId, valid: () => true, run: (voiceId) => saver(set)({ voiceId }), failure: 'Could not save the voice.' });
  return (
    <SettingsSection title="Voice" note={VOICE_NOTE}>
      <Link href={ELEVENLABS_VOICES_URL} />
      <SaveField saving={saving} name="voice-id" label="Voice ID" placeholder={voice.defaults.voiceId} />
    </SettingsSection>
  );
}

function VoiceModel({ voice, set }: { voice: VoiceSettings; set: Set }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const model = useModelQuery();
  const [open, setOpen] = useState(false);
  const current = voice.model === '' ? voice.defaults.model : voice.model;
  const settings = model.data;
  return (
    <SettingsSection title="Model" note={MODEL_NOTE}>
      <Text size="md">{voiceModelLabel(current)}</Text>
      {settings === undefined || settings.connections.length === 0 ? null : (
        <>
          <Button size="md" color="secondary" dark={dark} label="Change" onPress={() => { setOpen(true); }} />
          <ModelPickerModal
            open={open}
            settings={settings}
            title="Model for calls"
            isCurrent={(row) => `${row.provider}:${row.id}` === current}
            onPick={(row) => saver(set)({ model: `${row.provider}:${row.id}` })}
            onClose={() => { setOpen(false); }}
          />
        </>
      )}
    </SettingsSection>
  );
}

function VoiceBody(): ReactNode {
  const { voice, error, set } = useVoice();
  if (error !== null && error !== undefined) return <Text size="md" role="danger">{queryError(error, 'Could not read the voice settings.')}</Text>;
  if (voice === undefined) return <Loading />;
  return (
    <Col gap={32}>
      <SettingsGroup>
        <AnswerCalls voice={voice} set={set} />
        <SettingsSection title="Provider" compact>
          <Text size="md" role="secondary">{providerName(voice.provider)}</Text>
        </SettingsSection>
        <ApiKey voice={voice} set={set} />
      </SettingsGroup>
      <SettingsGroup>
        <VoiceId voice={voice} set={set} />
        <VoiceModel voice={voice} set={set} />
      </SettingsGroup>
    </Col>
  );
}

function VoiceGate(): ReactNode {
  const mode = useModeQuery();
  if (mode.data === undefined) return mode.error === null ? <Loading /> : <VoiceBody />;
  if (olderThan(mode.data.version, VOICE_SINCE)) return <EmptyCard text={`Needs metro ${VOICE_SINCE}. Update first, from the Server page.`} />;
  return <VoiceBody />;
}

export function VoicePage(): ReactNode {
  useDocumentTitle('Voice');
  return (
    <Col gap={32}>
      <PageTitle>Voice</PageTitle>
      <Text size="md" role="secondary">{INTRO}</Text>
      <VoiceGate />
    </Col>
  );
}
