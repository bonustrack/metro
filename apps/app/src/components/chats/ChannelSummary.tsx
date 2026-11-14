import { type ReactNode } from 'react';
import { stationLabel } from '@metro-labs/client/api/attach';
import { Summary } from '../ui/Summary.js';
import { type ChannelProps } from './channel-props.js';
import { useSenderCards } from './use-sender-cards.js';
import { useAgentName } from '../../lib/agent-hooks.js';
import { entriesOf, peopleOf } from '../../lib/channel-people.js';
import { channelSummary } from '../../lib/channel-summary.js';

export function ChannelSummary({ agentId, found, view }: Pick<ChannelProps, 'agentId' | 'found' | 'view'>): ReactNode {
  const agent = useAgentName();
  const { station, row } = found;
  const entries = entriesOf(row.allowlist);
  const cards = useSenderCards(agentId, station, row.id ?? '', entries);
  const segments = channelSummary({
    agent,
    station,
    label: stationLabel(station),
    row,
    tools: view.tools[station] ?? [],
    verbs: view.capabilities[station] ?? [],
    people: peopleOf({ station, entries, approvers: row.approvers, cards, seen: [], technical: false }),
    reportsStatus: view.reportsStatus.includes(station),
    pairAgain: view.pairAgain.includes(station),
  });
  return <Summary segments={segments} />;
}
