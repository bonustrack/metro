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

const styles = StyleSheet.create({ grow: { flex: 1, minWidth: 0 }, time: { flexShrink: 0 } });
const ICONS: Record<EntryKind, IconName> = { Message: 'chat', Tool: 'chip', Worker: 'users', Approval: 'hand', Error: 'exclamationCircle', System: 'check' };

function ActivityContext({ entry }: { entry: RunEntry }): ReactNode {
  return <Row gap={8} align="center" wrap>
    {entry.kind === 'Message' ? <Text size="2xs" role="secondary">{entry.station} · {short(entry.account, 20)} · {short(entry.channel, 40)}</Text>
      : <><Badge label={entry.status} color={entry.status === 'Failed' ? 'danger' : entry.status === 'Waiting' ? 'warning' : undefined} /><Text size="2xs" role="secondary">{entry.station}{entry.worker === 'Unlinked' ? '' : ` · ${short(entry.worker)}`}</Text></>}
    {entry.truncated && <Text size="2xs" role="secondary">Truncated</Text>}
  </Row>;
}

function RunActivityRow({ entry, selected, onSelect }: { entry: RunEntry; selected: boolean; onSelect: () => void }): ReactNode {
  const palette = useKitPalette();
  const message = entry.kind === 'Message';
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${entry.title} at ${clock(entry.at)} UTC`}
    accessibilityState={{ selected }} onPress={onSelect} testID={`event-${entry.id}`}>
    <Box background={selected ? palette.inputBg : palette.bg} border={{ bottom: { width: 1, color: palette.border } }} padding={{ x: 12, y: message ? 16 : 12 }}>
      <Row gap={12} align="start">
        <Box width={32} padding={{ top: 2 }}>{message ? <AgentAvatar seed={entry.senderId} size={32} />
          : <Row width={32} height={32} align="center" justify="center"><Icon name={ICONS[entry.kind]} size={20} color={entry.status === 'Failed' ? palette.danger : palette.text} /></Row>}</Box>
        <Col style={styles.grow} gap={message ? 6 : 4}>
          <Row align="center" gap={8} wrap>
            <Text size="sm" weight="semibold">{short(entry.sender, 48)}</Text>
            <Text size="2xs" role="secondary">{message ? entry.direction === 'inbound' ? 'received' : 'sent' : entry.title}</Text>
            <Box style={styles.grow} /><Text size="2xs" role="secondary" style={styles.time}>{clock(entry.at)}</Text>
          </Row>
          <Text size="sm" numberOfLines={4}>{entry.text}</Text>
          <ActivityContext entry={entry} />
        </Col>
      </Row>
    </Box>
  </Pressable>;
}

interface ActivityProps {
  entries: RunEntry[];
  selected: string | null;
  onSelect: (id: string) => void;
  limit: number;
  onMore: () => void;
  onReset: () => void;
}

export function RunActivity({ entries, selected, onSelect, limit, onMore, onReset }: ActivityProps): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  return <Col testID="activity-list" border={{ top: { width: 1, color: palette.border } }}>
    {entries.length === 0 ? <Col padding={24} gap={12}>
      <Text weight="semibold">No matching activity</Text>
      <Text size="sm" role="secondary">Only retained Metro events and the latest SDK snapshot are available. Try fewer filters.</Text>
      <Button dark={dark} color="secondary" label="Clear filters" onPress={onReset} />
    </Col> : entries.slice(0, limit).map((entry) => <RunActivityRow key={entry.id} entry={entry} selected={selected === entry.id} onSelect={() => { onSelect(entry.id); }} />)}
    {entries.length > limit && <Box padding={16}><Button dark={dark} color="secondary" label={`Show older events (${String(entries.length - limit)})`} onPress={onMore} /></Box>}
  </Col>;
}
