import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Choice } from './Choice.js';
import { Loading } from './Loading.js';
import { AgentDeepPage } from './agent/AgentDeepPage.js';
import { SaveField, useSave } from './SaveField.js';
import { Block, Control } from './settings/rows.js';
import { Group } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { queryError, useBoxQuery, useModeQuery } from '../lib/queries.js';
import { olderThan } from '@metro-labs/client/api/version';
import { routeHash } from '@metro-labs/client/route';
import {
  ELEVENLABS_KEYS_URL,
  ELEVENLABS_VOICES_URL,
  fetchVoice,
  providerName,
  saveVoice,
  VOICE_LANGUAGES,
  VOICE_SINCE,
  type VoicePatch,
  type VoiceSettings,
} from '@metro-labs/client/api/voice';
import { useDocumentTitle } from '../lib/title.js';
import { TextLink } from './TextLink.js';

const INTRO =
  'Call your agent from Stage and talk live, with voice by ElevenLabs. The call goes into the agent’s own conversation, on the model of the Model page, with all its tools, and it knows the chat you call from. It answers only people who can approve there.';
const PORTS_NOTE = 'The server needs inbound UDP ports 40000 to 40100 open for the call audio.';
const KEY_NOTE = 'Give the key Speech to Text and Text to Speech access. Create one in ElevenLabs:';
const VOICE_NOTE = 'Empty means Sarah, the default. Paste any voice ID from the ElevenLabs library:';
const LANGUAGE_NOTE = 'The language you speak on calls. Detect lets ElevenLabs guess each time.';

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

function FieldBlock({ title, note, href, children }: { title: string; note: string; href: string; children: ReactNode }): ReactNode {
  return (
    <Block>
      <Col gap={2}>
        <Text size="md">{title}</Text>
        <Text size="xs" role="secondary">
          {note}
        </Text>
      </Col>
      <TextLink url={href}>{href.replace(/^https:\/\//, '')}</TextLink>
      {children}
    </Block>
  );
}

interface ChoiceSettingProps<T extends string> {
  title: string;
  note: string;
  value: T;
  options: { value: T; label: string }[];
  patch: (value: T) => VoicePatch;
  set: Set;
}

function ChoiceSetting<T extends string>({ title, note, value, options, patch, set }: ChoiceSettingProps<T>): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = (next: T): void => {
    setBusy(true);
    setError(null);
    saveVoice(patch(next))
      .then(set)
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not change it.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Control title={title} note={note} error={error}>
      <Choice label={title} value={value} options={options} disabled={busy} onChange={pick} />
    </Control>
  );
}

function AnswerCalls({ voice, set }: { voice: VoiceSettings; set: Set }): ReactNode {
  return (
    <ChoiceSetting
      title="Answer calls"
      note={voice.hasKey ? PORTS_NOTE : 'Add an API key below first.'}
      value={voice.enabled ? 'on' : 'off'}
      options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
      patch={(value) => ({ enabled: value === 'on' })}
      set={set}
    />
  );
}

function VoiceLanguage({ voice, set }: { voice: VoiceSettings; set: Set }): ReactNode {
  return (
    <ChoiceSetting
      title="Language"
      note={LANGUAGE_NOTE}
      value={voice.language === null || voice.language === '' ? voice.defaults.language : voice.language}
      options={VOICE_LANGUAGES}
      patch={(language) => ({ language })}
      set={set}
    />
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
    <FieldBlock title={`${providerName(voice.provider)} API key`} note={KEY_NOTE} href={ELEVENLABS_KEYS_URL}>
      <SaveField saving={saving} name="voice-api-key" label="API key" placeholder={voice.hasKey ? 'Saved. Paste a new key to replace it.' : 'Paste the key'} secret />
    </FieldBlock>
  );
}

function VoiceId({ voice, set }: { voice: VoiceSettings; set: Set }): ReactNode {
  const saving = useSave({ initial: voice.voiceId, valid: () => true, run: (voiceId) => saver(set)({ voiceId }), failure: 'Could not save the voice.' });
  return (
    <FieldBlock title="Voice" note={VOICE_NOTE} href={ELEVENLABS_VOICES_URL}>
      <SaveField saving={saving} name="voice-id" label="Voice ID" placeholder={voice.defaults.voiceId} />
    </FieldBlock>
  );
}

function VoiceBody(): ReactNode {
  const { voice, error, set } = useVoice();
  if (error !== null && error !== undefined) return <Text size="md" role="danger">{queryError(error, 'Could not read the voice settings.')}</Text>;
  if (voice === undefined) return <Loading />;
  return (
    <>
      <Group label="Calls">
        <AnswerCalls voice={voice} set={set} />
        <Item title="Provider" value={providerName(voice.provider)} />
        <ApiKey voice={voice} set={set} />
      </Group>
      <Group label="Voice">
        <VoiceId voice={voice} set={set} />
        {voice.language === null ? null : <VoiceLanguage voice={voice} set={set} />}
      </Group>
    </>
  );
}

function VoiceGate({ project }: { project: string }): ReactNode {
  const mode = useModeQuery();
  if (mode.data === undefined) return mode.error === null ? <Loading /> : <VoiceBody />;
  if (olderThan(mode.data.version, VOICE_SINCE))
    return <Item title={`Needs Metro ${VOICE_SINCE}`} subtitle="Update it first: open Settings, then Metro version under Server." href={routeHash({ kind: 'agent-settings', project })} />;
  return <VoiceBody />;
}

export function VoicePage({ project }: { project: string }): ReactNode {
  useDocumentTitle('Voice calls');
  return (
    <AgentDeepPage project={project} tab="chats" trail={[{ label: 'Voice calls' }]} title="Voice calls" lead={INTRO}>
      <VoiceGate project={project} />
    </AgentDeepPage>
  );
}
