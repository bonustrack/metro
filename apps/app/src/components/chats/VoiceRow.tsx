import { type ReactNode } from 'react';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { type FlatAccount } from '@metro-labs/client/api/accounts';
import { routeHash } from '@metro-labs/client/route';
import { fetchVoice, VOICE_SINCE } from '@metro-labs/client/api/voice';
import { olderThan } from '@metro-labs/client/api/version';
import { Icon } from '../Icon.js';
import { Item } from '../ui/Item.js';
import { Section } from './Section.js';
import { useSenderCards } from './use-sender-cards.js';
import { namesList, peopleOf, approverNames } from '../../lib/channel-people.js';
import { useBoxQuery, useModeQuery } from '../../lib/queries.js';

const MARK = 24;

function useCallers(agentId: string, stage: FlatAccount | undefined): string | null {
  const approvers = stage?.row.approvers ?? [];
  const cards = useSenderCards(agentId, 'xmtp', stage?.row.id ?? '', approvers);
  if (stage === undefined) return null;
  const names = approverNames(peopleOf({ station: 'xmtp', entries: approvers, approvers, cards, seen: [], technical: false }));
  return names.length === 0 ? '' : namesList(names);
}

function subtitleOf(stage: FlatAccount | undefined, callers: string | null, old: boolean): string {
  if (old) return `Needs Metro ${VOICE_SINCE}`;
  if (stage === undefined || callers === null) return 'Needs a Stage chat';
  return callers === '' ? 'Nobody can call yet. Turn on Can approve on Stage.' : `${callers}, on Stage`;
}

export function VoiceRow({ project, agentId, accounts }: { project: string; agentId: string; accounts: FlatAccount[] }): ReactNode {
  const palette = useKitPalette();
  const stage = accounts.find((item) => item.station === 'xmtp' && item.row.id !== null);
  const callers = useCallers(agentId, stage);
  const mode = useModeQuery();
  const old = mode.data !== undefined && olderThan(mode.data.version, VOICE_SINCE);
  const voice = useBoxQuery('voice', fetchVoice, { enabled: !old, retry: false });
  const value = voice.data === undefined ? undefined : voice.data.enabled && voice.data.hasKey ? 'On' : 'Off';
  return (
    <Section>
      <Item
        title="Voice calls"
        subtitle={subtitleOf(stage, callers, old)}
        leading={<Icon name="microphone" size={MARK} color={palette.text} />}
        value={value}
        href={routeHash({ kind: 'voice', project })}
      />
    </Section>
  );
}
