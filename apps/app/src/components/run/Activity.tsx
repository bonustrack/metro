import type { ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { AgentAvatar } from '../AgentAvatar.js';
import { Icon, type IconName } from '../Icon.js';
import { clock, short, type EntryKind, type RunEntry } from './model.js';
import { entryPlace, entrySender, entryText, entryTime, statusWord } from './words.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { AVATAR_SIZE, ICON_SIZE } from '../ui/sizes.js';

const styles = StyleSheet.create({ grow: { flex: 1, minWidth: 0 }, time: { flexShrink: 0 } });
const ICONS: Record<EntryKind, IconName> = { Message: 'chat', Tool: 'chip', Worker: 'users', Approval: 'hand', Error: 'exclamationCircle', System: 'check' };

function ActivityContext({ entry }: { entry: RunEntry }): ReactNode {
  const technical = useTechnicalDetails();
  return <Row gap={8} align="center" wrap>
    {entry.kind === 'Message' ? <Text size="md" color="secondary">{entryPlace(entry, technical)}</Text>
      : <><Badge label={statusWord(entry.status, technical)} color={entry.status === 'Failed' ? 'danger' : entry.status === 'Waiting' ? 'warning' : undefined} />{technical ? <Text size="md" color="secondary">{entry.station}{entry.worker === 'Unlinked' ? '' : ` · ${short(entry.worker)}`}</Text> : null}</>}
    {entry.truncated && <Text size="md" color="secondary">Truncated</Text>}
  </Row>;
}

function RunActivityRow({ entry, onSelect }: { entry: RunEntry; onSelect: () => void }): ReactNode {
  const palette = useKitPalette();
  const technical = useTechnicalDetails();
  const message = entry.kind === 'Message';
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${entry.title}, ${technical ? `${clock(entry.at)} UTC` : entryTime(entry.at, false)}`}
    onPress={onSelect} testID={`event-${entry.id}`}>
    <Column border={{ bottom: { width: 1, color: palette.border } }} padding={{ y: message ? 16 : 12 }}>
      <Row gap={12} align="start">
        <Column width={AVATAR_SIZE.row} padding={{ top: 2 }}>{message ? <AgentAvatar seed={entry.senderId} size={AVATAR_SIZE.row} />
          : <Row width={AVATAR_SIZE.row} height={AVATAR_SIZE.row} align="center" justify="center"><Icon name={ICONS[entry.kind]} size={ICON_SIZE.md} color={entry.status === 'Failed' ? palette.danger : palette.text} /></Row>}</Column>
        <Column style={styles.grow} gap={message ? 6 : 4}>
          <Row align="center" gap={8} wrap>
            <Text size="sm" fontWeight="semibold">{short(entrySender(entry, technical), 48)}</Text>
            <Text size="md" color="secondary">{message ? entry.direction === 'inbound' ? 'received' : 'sent' : entry.title}</Text>
            <Column style={styles.grow} /><Text size="md" color="secondary" style={styles.time}>{entryTime(entry.at, technical)}</Text>
          </Row>
          <Text size="sm" numberOfLines={4}>{entryText(entry, technical)}</Text>
          <ActivityContext entry={entry} />
        </Column>
      </Row>
    </Column>
  </Pressable>;
}

interface ActivityProps {
  entries: RunEntry[];
  onSelect: (id: string) => void;
  limit: number;
  onMore: () => void;
  onReset: () => void;
}

export function RunActivity({ entries, onSelect, limit, onMore, onReset }: ActivityProps): ReactNode {
  const palette = useKitPalette();
  return <Column testID="activity-list" border={{ top: { width: 1, color: palette.border } }}>
    {entries.length === 0 ? <Column padding={24} gap={12}>
      <Text fontWeight="semibold">No matching activity</Text>
      <Text size="sm" color="secondary">Only recent events are kept. Try fewer filters.</Text>
      <Button color="secondary" label="Clear filters" onPress={onReset} />
    </Column> : entries.slice(0, limit).map((entry) => <RunActivityRow key={entry.id} entry={entry} onSelect={() => { onSelect(entry.id); }} />)}
    {entries.length > limit && <Column padding={16}><Button color="secondary" label={`Show older events (${String(entries.length - limit)})`} onPress={onMore} /></Column>}
  </Column>;
}
