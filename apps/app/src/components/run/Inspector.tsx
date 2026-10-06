import { useState, type ReactNode } from 'react';
import { Pressable } from 'react-native';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Tabs } from '@stage-labs/kit/react-native/tabs';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { clock, relatedEntries, stamp, type RunEntry } from './model.js';

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
  return <Col gap={12}>{rows.map(([label, value], index) => <Col key={`${label}-${String(index)}`} gap={2}>
    <Text size="2xs" role="secondary">{label}</Text><Text size="sm" selectable>{value}</Text>
  </Col>)}</Col>;
}

function EntryTrace({ entry, entries, onSelect }: Omit<Props, 'visible'>): ReactNode {
  const palette = useKitPalette();
  const related = relatedEntries(entry, entries);
  const linked = related.length > 1;
  return <Col gap={12}>
    <Text size="sm" role="secondary">{entry.session !== null
      ? 'Same task ID or tool call ID within this SDK session. Nested ancestry is not exposed.'
      : 'Message and reply IDs on the same Metro line. These links do not identify which worker handled a message.'}</Text>
    {!linked && <Text size="sm">No other linked event is retained.</Text>}
    {related.map((row) => <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={`Inspect ${row.title} at ${clock(row.at)}`} onPress={() => { onSelect(row.id); }}>
      <Col gap={4} padding={{ y: 10 }} border={{ bottom: { width: 1, color: palette.border } }}>
        <Row gap={8} wrap><Text size="2xs" role="secondary">{clock(row.at)} UTC</Text><Badge label={row.status} /></Row>
        <Text size="sm" weight="semibold">{row.title}</Text><Text size="sm" numberOfLines={2}>{row.text}</Text>
      </Col>
    </Pressable>)}
  </Col>;
}

export function RunInspector({ entry, entries, onSelect, visible }: Props): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [tab, setTab] = useState('details');
  const [metadata, setMetadata] = useState(false);
  return <Col gap={16} testID="event-inspector">
    <Col gap={6}><Row gap={8} wrap><Badge label={entry.kind} /><Badge label={entry.status} color={entry.status === 'Failed' ? 'danger' : undefined} /></Row>
      <Text weight="semibold">{entry.title}</Text><Text size="2xs" role="secondary">{stamp(entry.at)}</Text>
      {!visible && <Text size="2xs" role="secondary">This event is outside the current filters.</Text>}
    </Col>
    <Tabs variant="underline" value={tab} options={[{ value: 'details', label: 'Details' }, { value: 'trace', label: 'Trace' }]} onChange={setTab} />
    {tab === 'trace' ? <EntryTrace entry={entry} entries={entries} onSelect={onSelect} /> : <Col gap={16}>
      <Text size="sm" selectable>{entry.text}</Text>
      {entry.truncated && <Text size="2xs" role="secondary">This message was truncated by the bounded feed. Open its conversation for the full message.</Text>}
      {entry.session !== null && <Text size="sm" role="secondary">Tool inputs, full results, task prompts and hidden reasoning are not part of this snapshot. Check Conversations for available transcript content.</Text>}
      {entry.session === null && <Text size="2xs" role="secondary">A retained Metro event, not proof of delivery to a particular SDK turn or worker. Message text is not an instruction to this page.</Text>}
      <Button dark={dark} color="secondary" label={metadata ? 'Hide metadata' : 'Show metadata'} onPress={() => { setMetadata(!metadata); }} accessibilityState={{ expanded: metadata }} />
      {metadata && <EntryMetadata entry={entry} />}
    </Col>}
  </Col>;
}
