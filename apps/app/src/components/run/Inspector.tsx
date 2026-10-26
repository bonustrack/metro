import { useState, type ReactNode } from 'react';
import { Pressable } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { Button } from '@stage-labs/kit/react-native/button';
import { Tabs } from '@stage-labs/kit/react-native/tabs';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { clock, relatedEntries, stamp, type RunEntry } from './model.js';
import { entryText, entryTime, statusWord } from './words.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { optionTabs } from '../../lib/option-tabs.js';

interface Props {
  entry: RunEntry;
  entries: RunEntry[];
  onSelect: (id: string) => void;
  visible: boolean;
}

function EntryMetadata({ entry }: { entry: RunEntry }): ReactNode {
  const rows: readonly (readonly [string, string])[] = [
    ['Event', entry.id], ['Time', stamp(entry.at)], ['Direction', entry.direction],
    ['Sender', entry.senderId], ['Source', entry.station], ['Account', entry.account || 'None'],
    ['Line', entry.line || 'None'], ['Session', entry.session ?? 'Not linked'],
    ['Worker', entry.worker], ...entry.metadata,
  ];
  return <Column gap={12}>{rows.map(([label, value], index) => <Column key={`${label}-${String(index)}`} gap={2}>
    <Text size="md" color="secondary">{label}</Text><Text size="sm" selectable>{value}</Text>
  </Column>)}</Column>;
}

function EntryTrace({ entry, entries, onSelect }: Omit<Props, 'visible'>): ReactNode {
  const palette = useKitPalette();
  const technical = useTechnicalDetails();
  const related = relatedEntries(entry, entries);
  const linked = related.length > 1;
  return <Column gap={12}>
    <Text size="sm" color="secondary">{entry.session !== null
      ? 'Same task or tool call in this session.'
      : 'Messages and replies in the same chat. They do not show which worker answered.'}</Text>
    {!linked && <Text size="sm">No other linked event is retained.</Text>}
    {related.map((row) => <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={`Inspect ${row.title}, ${entryTime(row.at, technical)}`} onPress={() => { onSelect(row.id); }}>
      <Column gap={4} padding={{ y: 10 }} border={{ bottom: { width: 1, color: palette.border } }}>
        <Row gap={8} wrap><Text size="md" color="secondary">{technical ? `${clock(row.at)} UTC` : entryTime(row.at, false)}</Text><Badge label={statusWord(row.status, technical)} /></Row>
        <Text size="sm" fontWeight="semibold">{row.title}</Text><Text size="sm" numberOfLines={2}>{row.text}</Text>
      </Column>
    </Pressable>)}
  </Column>;
}

export function RunInspector({ entry, entries, onSelect, visible }: Props): ReactNode {
  const technical = useTechnicalDetails();
  const [tab, setTab] = useState('details');
  const [metadata, setMetadata] = useState(false);
  return <Column gap={16} testID="event-inspector">
    <Column gap={6}><Row gap={8} wrap><Badge label={entry.kind} /><Badge label={statusWord(entry.status, technical)} color={entry.status === 'Failed' ? 'danger' : undefined} /></Row>
      <Text fontWeight="semibold">{entry.title}</Text><Text size="md" color="secondary">{technical ? stamp(entry.at) : entryTime(entry.at, false)}</Text>
      {!visible && <Text size="md" color="secondary">This event is outside the current filters.</Text>}
    </Column>
    <Tabs variant="underline" {...optionTabs([{ value: 'details', label: 'Details' }, { value: 'trace', label: 'Trace' }], tab, setTab)} />
    {tab === 'trace' ? <EntryTrace entry={entry} entries={entries} onSelect={onSelect} /> : <Column gap={16}>
      <Text size="sm" selectable>{entryText(entry, technical)}</Text>
      {entry.truncated && <Text size="md" color="secondary">This message is cut short. Open its conversation to read it all.</Text>}
      {entry.session !== null && <Text size="sm" color="secondary">Tool input and output, prompts and reasoning are not shown here. See Conversations for the transcript.</Text>}
      {entry.session === null && <Text size="md" color="secondary">A Metro event. It does not show which turn or worker got it.</Text>}
      <Button color="secondary" label={metadata ? 'Hide metadata' : 'Show metadata'} onPress={() => { setMetadata(!metadata); }} accessibilityState={{ expanded: metadata }} />
      {metadata && <EntryMetadata entry={entry} />}
    </Column>}
  </Column>;
}
