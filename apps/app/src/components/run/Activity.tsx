import type { ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { Box, Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
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
    {entry.kind === 'Message' ? <Text size="md" role="secondary">{entryPlace(entry, technical)}</Text>
      : <><Badge label={statusWord(entry.status, technical)} color={entry.status === 'Failed' ? 'danger' : entry.status === 'Waiting' ? 'warning' : undefined} />{technical ? <Text size="md" role="secondary">{entry.station}{entry.worker === 'Unlinked' ? '' : ` · ${short(entry.worker)}`}</Text> : null}</>}
    {entry.truncated && <Text size="md" role="secondary">Truncated</Text>}
  </Row>;
}

function RunActivityRow({ entry, onSelect }: { entry: RunEntry; onSelect: () => void }): ReactNode {
  const palette = useKitPalette();
  const technical = useTechnicalDetails();
  const message = entry.kind === 'Message';
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${entry.title}, ${technical ? `${clock(entry.at)} UTC` : entryTime(entry.at, false)}`}
    onPress={onSelect} testID={`event-${entry.id}`}>
    <Box border={{ bottom: { width: 1, color: palette.border } }} padding={{ y: message ? 16 : 12 }}>
      <Row gap={12} align="start">
        <Box width={AVATAR_SIZE.row} padding={{ top: 2 }}>{message ? <AgentAvatar seed={entry.senderId} size={AVATAR_SIZE.row} />
          : <Row width={AVATAR_SIZE.row} height={AVATAR_SIZE.row} align="center" justify="center"><Icon name={ICONS[entry.kind]} size={ICON_SIZE.md} color={entry.status === 'Failed' ? palette.danger : palette.text} /></Row>}</Box>
        <Col style={styles.grow} gap={message ? 6 : 4}>
          <Row align="center" gap={8} wrap>
            <Text size="sm" weight="semibold">{short(entrySender(entry, technical), 48)}</Text>
            <Text size="md" role="secondary">{message ? entry.direction === 'inbound' ? 'received' : 'sent' : entry.title}</Text>
            <Box style={styles.grow} /><Text size="md" role="secondary" style={styles.time}>{entryTime(entry.at, technical)}</Text>
          </Row>
          <Text size="sm" numberOfLines={4}>{entryText(entry, technical)}</Text>
          <ActivityContext entry={entry} />
        </Col>
      </Row>
    </Box>
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
  const dark = useKitScheme() === 'dark';
  return <Col testID="activity-list" border={{ top: { width: 1, color: palette.border } }}>
    {entries.length === 0 ? <Col padding={24} gap={12}>
      <Text weight="semibold">No matching activity</Text>
      <Text size="sm" role="secondary">Only recent events are kept. Try fewer filters.</Text>
      <Button dark={dark} color="secondary" label="Clear filters" onPress={onReset} />
    </Col> : entries.slice(0, limit).map((entry) => <RunActivityRow key={entry.id} entry={entry} onSelect={() => { onSelect(entry.id); }} />)}
    {entries.length > limit && <Box padding={16}><Button dark={dark} color="secondary" label={`Show older events (${String(entries.length - limit)})`} onPress={onMore} /></Box>}
  </Col>;
}
