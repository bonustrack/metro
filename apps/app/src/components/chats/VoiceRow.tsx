import { type ReactNode } from 'react';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { allowsEveryone, type FlatAccount } from '@metro-labs/client/api/accounts';
import { routeHash } from '@metro-labs/client/route';
import { fetchVoice, VOICE_SINCE } from '@metro-labs/client/api/voice';
import { olderThan } from '@metro-labs/client/api/version';
import { Icon } from '../Icon.js';
import { Item } from '../ui/Item.js';
import { Group } from '../ui/Group.js';
import { useSenderCards } from './use-sender-cards.js';
import { peopleOf, approverNames, entriesOf } from '../../lib/channel-people.js';
import { useChatApprovals } from '../../lib/chat-approvals.js';
import { namesList } from '../../lib/rule-sentence.js';
import { useBoxQuery, useModeQuery } from '../../lib/queries.js';
import { ICON_SIZE } from '../ui/sizes.js';

const MARK = ICON_SIZE.lg;

const listedWriters = (allowlist: string[] | null): string[] => (allowsEveryone(allowlist) ? [] : entriesOf(allowlist));

function useCallers(agentId: string, stage: FlatAccount | undefined, chat: boolean): string | null {
  const callers = chat ? stage?.row.approvers ?? [] : listedWriters(stage?.row.allowlist ?? null);
  const cards = useSenderCards(agentId, 'xmtp', stage?.row.id ?? '', callers);
  if (stage === undefined) return null;
  const names = approverNames(peopleOf({ station: 'xmtp', entries: callers, approvers: callers, cards, seen: [], technical: false }));
  return names.length === 0 ? '' : namesList(names);
}

function subtitleOf(stage: FlatAccount | undefined, callers: string | null, old: boolean, chat: boolean): string {
  if (old) return `Needs Metro ${VOICE_SINCE}`;
  if (stage === undefined || callers === null) return 'Needs a Stage chat';
  if (callers !== '') return `${callers}, on Stage`;
  return chat ? 'Nobody can call yet. Turn on Can approve on Stage.' : 'Nobody can call yet. Choose who can write on Stage.';
}

export function VoiceRow({ project, agentId, accounts }: { project: string; agentId: string; accounts: FlatAccount[] }): ReactNode {
  const palette = useKitPalette();
  const stage = accounts.find((item) => item.station === 'xmtp' && item.row.id !== null);
  const chat = useChatApprovals();
  const callers = useCallers(agentId, stage, chat);
  const mode = useModeQuery();
  const old = mode.data !== undefined && olderThan(mode.data.version, VOICE_SINCE);
  const voice = useBoxQuery('voice', fetchVoice, { enabled: !old, retry: false });
  const value = voice.data === undefined ? undefined : voice.data.enabled && voice.data.hasKey ? 'On' : 'Off';
  return (
    <Group>
      <Item
        title="Voice calls"
        subtitle={subtitleOf(stage, callers, old, chat)}
        leading={<Icon name="microphone" size={MARK} color={palette.text} />}
        value={value}
        href={routeHash({ kind: 'voice', project })}
      />
    </Group>
  );
}
